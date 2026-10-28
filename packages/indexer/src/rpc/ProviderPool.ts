import { EventEmitter } from "node:events";
import type { Hex } from "viem";
import type { CircuitState, ProviderHealthDto } from "@reorg-safe/shared";
import { AllProvidersFailedError, NoProvidersAvailableError, errorMessage } from "./errors.ts";
import type { Attributed, CanonicalVote, RpcClient } from "./types.ts";

export interface ProviderPoolOptions {
  /** Consecutive failures that open a provider's circuit. */
  failureThreshold?: number;
  /** Initial duration a circuit stays open; doubles on each re-open up to `openMaxMs`. */
  openBaseMs?: number;
  openMaxMs?: number;
  /** Providers consulted for head height and canonical-hash votes. */
  quorum?: number;
  /** Blocks a provider may trail the best head before being flagged lagging. */
  lagTolerance?: bigint;
  /** Smoothing factor for the latency EWMA. */
  ewmaAlpha?: number;
  now?: () => number;
}

interface ProviderState {
  client: RpcClient;
  url: string;
  state: CircuitState;
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
  ewmaLatencyMs: number;
  lastHead: bigint | null;
  lagging: boolean;
  lastError: string | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  openUntil: number | null;
  reopenCount: number;
}

export type ProviderPoolEvents = {
  change: [ProviderHealthDto[]];
  "circuit-open": [{ url: string; until: number; reason: string }];
  "circuit-closed": [{ url: string }];
  lagging: [{ url: string; head: bigint; best: bigint }];
};

/**
 * Health-aware JSON-RPC router.
 *
 *  - Every call is tried against providers in score order (latency EWMA, failures, circuit state)
 *    and fails over to the next on error. Callers get the value *and* the provider URL so they can
 *    attribute inconsistent data back to its source.
 *  - A per-provider circuit breaker opens after `failureThreshold` consecutive failures, with
 *    exponential back-off, and probes with a single call when half-open.
 *  - `getHead` and `canonicalHash` fan out to a quorum of providers so that one lagging or forked
 *    node cannot, on its own, make the indexer believe a reorg happened (or hide one).
 */
export class ProviderPool extends EventEmitter<ProviderPoolEvents> {
  private readonly providers: ProviderState[];
  private readonly failureThreshold: number;
  private readonly openBaseMs: number;
  private readonly openMaxMs: number;
  private readonly quorum: number;
  private readonly lagTolerance: bigint;
  private readonly ewmaAlpha: number;
  private readonly now: () => number;

  constructor(clients: RpcClient[], opts: ProviderPoolOptions = {}) {
    super();
    if (clients.length === 0) throw new Error("ProviderPool requires at least one client");
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.openBaseMs = opts.openBaseMs ?? 5_000;
    this.openMaxMs = opts.openMaxMs ?? 60_000;
    this.quorum = Math.max(1, Math.min(opts.quorum ?? 2, clients.length));
    this.lagTolerance = opts.lagTolerance ?? 2n;
    this.ewmaAlpha = opts.ewmaAlpha ?? 0.3;
    this.now = opts.now ?? (() => Date.now());
    this.providers = clients.map((client) => ({
      client,
      url: client.url,
      state: "closed",
      consecutiveFailures: 0,
      totalCalls: 0,
      totalFailures: 0,
      ewmaLatencyMs: 0,
      lastHead: null,
      lagging: false,
      lastError: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      openUntil: null,
      reopenCount: 0,
    }));
  }

  get size(): number {
    return this.providers.length;
  }

  /** Current health of every provider, best-ranked first. */
  snapshot(): ProviderHealthDto[] {
    this.refreshCircuits();
    return [...this.providers].sort((a, b) => this.score(a) - this.score(b)).map((p) => ({
      url: p.url,
      state: p.state,
      consecutiveFailures: p.consecutiveFailures,
      totalCalls: p.totalCalls,
      totalFailures: p.totalFailures,
      ewmaLatencyMs: Math.round(p.ewmaLatencyMs * 10) / 10,
      lastHead: p.lastHead === null ? null : Number(p.lastHead),
      lagging: p.lagging,
      lastError: p.lastError,
      lastSuccessAt: p.lastSuccessAt,
      lastFailureAt: p.lastFailureAt,
      openUntil: p.openUntil,
    }));
  }

  /**
   * Run `fn` against the best available provider, failing over on error.
   * Throws AllProvidersFailedError once every candidate has failed.
   */
  async call<T>(label: string, fn: (client: RpcClient) => Promise<T>, exclude?: ReadonlySet<string>): Promise<Attributed<T>> {
    const candidates = this.ranked(exclude);
    if (candidates.length === 0) throw new NoProvidersAvailableError(label);

    const failures: Array<{ url: string; error: unknown }> = [];
    for (const p of candidates) {
      const started = this.now();
      try {
        const value = await fn(p.client);
        this.markSuccess(p, this.now() - started);
        return { value, url: p.url };
      } catch (error) {
        this.markFailure(p, error);
        failures.push({ url: p.url, error });
      }
    }
    throw new AllProvidersFailedError(label, failures);
  }

  /** Run `fn` against up to `n` distinct providers in parallel; returns the successful results. */
  async fanout<T>(label: string, fn: (client: RpcClient) => Promise<T>, n: number): Promise<Attributed<T>[]> {
    const candidates = this.ranked().slice(0, Math.max(1, n));
    if (candidates.length === 0) throw new NoProvidersAvailableError(label);

    const settled = await Promise.allSettled(
      candidates.map(async (p) => {
        const started = this.now();
        try {
          const value = await fn(p.client);
          this.markSuccess(p, this.now() - started);
          return { value, url: p.url };
        } catch (error) {
          this.markFailure(p, error);
          throw error;
        }
      }),
    );

    const ok: Attributed<T>[] = [];
    const failures: Array<{ url: string; error: unknown }> = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") ok.push(r.value);
      else failures.push({ url: candidates[i]!.url, error: r.reason });
    });
    if (ok.length === 0) throw new AllProvidersFailedError(label, failures);
    return ok;
  }

  /**
   * Best head height across the quorum. Providers trailing the best by more than `lagTolerance`
   * are flagged as lagging and de-prioritised for subsequent calls.
   */
  async getHead(): Promise<bigint> {
    const results = await this.fanout("eth_blockNumber", (c) => c.getBlockNumber(), this.quorum);
    let best = results[0]!.value;
    for (const r of results) if (r.value > best) best = r.value;

    let changed = false;
    for (const r of results) {
      const p = this.byUrl(r.url);
      p.lastHead = r.value;
      const lagging = best - r.value > this.lagTolerance;
      if (lagging !== p.lagging) {
        changed = true;
        p.lagging = lagging;
        if (lagging) this.emit("lagging", { url: p.url, head: r.value, best });
      }
    }
    if (changed) this.emitChange();
    return best;
  }

  /**
   * Ask the quorum which block hash is canonical at `number`. `null` votes mean "no block at
   * that height". Consensus requires a strict majority of the providers that answered.
   */
  async canonicalHash(number: bigint): Promise<CanonicalVote> {
    const results = await this.fanout(`eth_getBlockByNumber(${number})`, (c) => c.getBlock(number), this.quorum);
    const votes = results.map((r) => ({ url: r.url, hash: r.value?.hash ?? null }));

    const tally = new Map<Hex | null, number>();
    for (const v of votes) tally.set(v.hash, (tally.get(v.hash) ?? 0) + 1);

    let winner: Hex | null = null;
    let winnerCount = 0;
    for (const [hash, count] of tally) {
      if (count > winnerCount) {
        winner = hash;
        winnerCount = count;
      }
    }
    const consensus = winnerCount * 2 > votes.length;
    return { hash: consensus ? winner : null, consensus, votes };
  }

  /** Record that a provider served data contradicting the quorum-confirmed chain. */
  penalize(url: string, reason: string): void {
    const p = this.providers.find((x) => x.url === url);
    if (!p) return;
    this.markFailure(p, new Error(`inconsistent data: ${reason}`));
  }

  // ---------------------------------------------------------------- internals

  private byUrl(url: string): ProviderState {
    const p = this.providers.find((x) => x.url === url);
    if (!p) throw new Error(`unknown provider ${url}`);
    return p;
  }

  private refreshCircuits(): void {
    const now = this.now();
    for (const p of this.providers) {
      if (p.state === "open" && p.openUntil !== null && now >= p.openUntil) {
        p.state = "half-open";
      }
    }
  }

  private score(p: ProviderState): number {
    let s = p.ewmaLatencyMs || 1;
    s *= 1 + p.consecutiveFailures;
    if (p.state === "half-open") s += 10_000;
    if (p.lagging) s += 100_000;
    if (p.state === "open") s += 1_000_000;
    return s;
  }

  /** Usable providers, best first. Open circuits are excluded unless nothing else is left. */
  private ranked(exclude?: ReadonlySet<string>): ProviderState[] {
    this.refreshCircuits();
    const pool = this.providers.filter((p) => !exclude?.has(p.url));
    const usable = pool.filter((p) => p.state !== "open");
    const chosen = usable.length > 0 ? usable : pool; // last resort: probe an open circuit
    return [...chosen].sort((a, b) => this.score(a) - this.score(b));
  }

  private markSuccess(p: ProviderState, latencyMs: number): void {
    p.totalCalls++;
    p.consecutiveFailures = 0;
    p.lastSuccessAt = this.now();
    p.ewmaLatencyMs = p.ewmaLatencyMs === 0 ? latencyMs : p.ewmaLatencyMs * (1 - this.ewmaAlpha) + latencyMs * this.ewmaAlpha;
    if (p.state !== "closed") {
      p.state = "closed";
      p.openUntil = null;
      p.reopenCount = 0;
      this.emit("circuit-closed", { url: p.url });
      this.emitChange();
    }
  }

  private markFailure(p: ProviderState, error: unknown): void {
    p.totalCalls++;
    p.totalFailures++;
    p.consecutiveFailures++;
    p.lastFailureAt = this.now();
    p.lastError = errorMessage(error);

    const shouldOpen = p.state === "half-open" || p.consecutiveFailures >= this.failureThreshold;
    if (shouldOpen && p.state !== "open") {
      const duration = Math.min(this.openBaseMs * 2 ** p.reopenCount, this.openMaxMs);
      p.reopenCount++;
      p.state = "open";
      p.openUntil = this.now() + duration;
      this.emit("circuit-open", { url: p.url, until: p.openUntil, reason: p.lastError });
    }
    this.emitChange();
  }

  private emitChange(): void {
    this.emit("change", this.snapshot());
  }
}
