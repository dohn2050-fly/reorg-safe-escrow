import { EventEmitter } from "node:events";
import type { Address } from "viem";
import type { IndexerStatusDto, ReorgDto } from "@reorg-safe/shared";
import type { ChainSource, ChainTracker, LocalChainView, SyncPlan } from "../chain/ChainTracker.ts";
import type { LogSource } from "../chain/PoolChainSource.ts";
import type { IndexerDatabase } from "../db/Database.ts";
import type { Logger } from "../logger.ts";
import {
  AllProvidersFailedError,
  FinalityViolationError,
  InconsistentProviderDataError,
  ProjectionError,
  errorMessage,
} from "../rpc/errors.ts";
import type { BlockHeader, RawLog } from "../rpc/types.ts";
import { decodeEscrowLog, type DecodedEvent } from "./decode.ts";

export interface IndexerConfig {
  contract: Address;
  chainId: number;
  startBlock: bigint;
  confirmations: bigint;
  pollIntervalMs: number;
}

export interface IndexerDeps {
  source: ChainSource & LogSource;
  tracker: ChainTracker;
  db: IndexerDatabase;
  logger: Logger;
  config: IndexerConfig;
  now?: () => number;
}

export type IndexerEvents = {
  blocks: [{ from: number; to: number; events: number }];
  reorg: [ReorgDto];
  status: [IndexerStatusDto];
  fatal: [Error];
};

/**
 * Drives the sync loop: plan (ChainTracker) -> fetch & verify logs -> commit atomically (DB).
 *
 * Log verification: every log's blockHash must equal the hash of the header we are about to
 * commit at that height. This guarantees events are attributed to exactly the chain we track,
 * even when the logs come from a different provider than the headers.
 */
export class Indexer extends EventEmitter<IndexerEvents> {
  private readonly source: ChainSource & LogSource;
  private readonly tracker: ChainTracker;
  private readonly db: IndexerDatabase;
  private readonly log: Logger;
  private readonly cfg: IndexerConfig;
  private readonly now: () => number;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private remoteHead: bigint | null = null;
  private lastTickAt: number | null = null;
  private lastError: string | null = null;
  private backoffMs = 0;
  private readonly startedAt: number;

  constructor(deps: IndexerDeps) {
    super();
    this.source = deps.source;
    this.tracker = deps.tracker;
    this.db = deps.db;
    this.log = deps.logger;
    this.cfg = deps.config;
    this.now = deps.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loopPromise;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** One sync iteration. Public so tests and the chaos runner can step deterministically. */
  async tick(): Promise<SyncPlan> {
    const plan = await this.tracker.plan(this.localView());
    this.remoteHead = plan.head;
    this.lastTickAt = this.now();

    if (plan.kind === "idle") {
      this.log.debug("idle", { head: plan.head, reason: plan.reason });
      this.finalize(plan.head);
      return plan;
    }

    const events = await this.fetchVerifiedEvents(plan.blocks, plan.head);
    const first = plan.blocks[0]!;
    const last = plan.blocks[plan.blocks.length - 1]!;

    if (plan.kind === "extend") {
      this.db.commitExtend(plan.blocks, events);
      this.log.info("committed blocks", { from: first.number, to: last.number, events: events.length, head: plan.head });
    } else {
      const detectedAt = this.now();
      const result = this.db.commitReorg(
        { detectedAt, commonAncestor: plan.commonAncestor, oldTip: plan.oldTip, newTip: last.number, depth: plan.depth },
        plan.blocks,
        events,
      );
      const reorg: ReorgDto = {
        id: this.db.counts().reorgs,
        detectedAt,
        commonAncestor: Number(plan.commonAncestor),
        oldTip: Number(plan.oldTip.number),
        oldTipHash: plan.oldTip.hash,
        newTip: Number(last.number),
        depth: plan.depth,
        eventsRolledBack: result.eventsRemoved,
      };
      this.log.warn("reorg handled", {
        depth: plan.depth,
        commonAncestor: plan.commonAncestor,
        oldTip: plan.oldTip.number,
        newTip: last.number,
        eventsRolledBack: result.eventsRemoved,
        escrowsRebuilt: result.affectedEscrows.length,
        newEvents: events.length,
      });
      this.emit("reorg", reorg);
    }

    this.emit("blocks", { from: Number(first.number), to: Number(last.number), events: events.length });
    this.finalize(plan.head);
    this.emit("status", this.status());
    return plan;
  }

  status(): IndexerStatusDto {
    const tip = this.db.getTip();
    const finalized = this.db.getFinalized();
    const counts = this.db.counts();
    return {
      chainId: this.cfg.chainId,
      contract: this.cfg.contract,
      startBlock: Number(this.cfg.startBlock),
      confirmations: Number(this.cfg.confirmations),
      localTip: tip ? Number(tip.number) : null,
      localTipHash: tip?.hash ?? null,
      finalized: finalized === null ? null : Number(finalized),
      remoteHead: this.remoteHead === null ? null : Number(this.remoteHead),
      lag: tip && this.remoteHead !== null ? Number(this.remoteHead - tip.number) : null,
      reorgCount: counts.reorgs,
      eventCount: counts.events,
      escrowCount: counts.escrows,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      running: this.running,
      startedAt: this.startedAt,
    };
  }

  // ---------------------------------------------------------------- internals

  private localView(): LocalChainView {
    return {
      tip: this.db.getTip(),
      finalized: this.db.getFinalized(),
      getBlock: (n) => this.db.getBlock(n),
    };
  }

  /**
   * Fetch the logs for `blocks` in a way that cannot be fooled by a provider on another fork.
   *
   *  - Blocks already `confirmations` deep are fetched as one range query (cheap). Every returned
   *    log must carry the block hash we track at that height; a mismatch penalises the provider
   *    and retries elsewhere.
   *  - Blocks inside the reorg-risk window are fetched per block *by hash* (EIP-234). A provider
   *    that does not know the hash errors out, so it can neither mis-attribute nor silently omit
   *    events; the pool then fails over to a provider that does know the block.
   */
  private async fetchVerifiedEvents(blocks: BlockHeader[], head: bigint): Promise<DecodedEvent[]> {
    const safeHeight = head - this.cfg.confirmations;
    const deep = blocks.filter((b) => b.number <= safeHeight);
    const recent = blocks.filter((b) => b.number > safeHeight);
    const logs: RawLog[] = [];

    if (deep.length > 0) logs.push(...(await this.fetchRangeVerified(deep)));
    for (const block of recent) {
      const { value } = await this.source.getLogsByBlockHash({ address: this.cfg.contract, blockHash: block.hash });
      logs.push(...value);
    }

    const events: DecodedEvent[] = [];
    for (const l of logs) {
      if (l.removed) continue;
      const decoded = decodeEscrowLog(l);
      if (decoded) events.push(decoded);
    }
    events.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    return events;
  }

  private async fetchRangeVerified(blocks: BlockHeader[]): Promise<RawLog[]> {
    const byNumber = new Map<bigint, BlockHeader>(blocks.map((b) => [b.number, b]));
    const fromBlock = blocks[0]!.number;
    const toBlock = blocks[blocks.length - 1]!.number;
    const exclude = new Set<string>();

    for (let attempt = 0; attempt < 3; attempt++) {
      const { value: logs, url } = await this.source.getLogs({ address: this.cfg.contract, fromBlock, toBlock }, exclude);
      const bad = logs.find((l) => byNumber.get(l.blockNumber)?.hash !== l.blockHash);
      if (!bad) return logs;

      const reason = `log in block ${bad.blockNumber} has hash ${bad.blockHash}, expected ${byNumber.get(bad.blockNumber)?.hash ?? "none"}`;
      this.source.penalize(url, reason);
      exclude.add(url);
      this.log.warn("logs provider disagrees with tracked headers, retrying elsewhere", { url, reason });
    }
    throw new InconsistentProviderDataError([...exclude].join(","), "no provider returned logs consistent with the tracked headers");
  }

  private finalize(head: bigint): void {
    const tip = this.db.getTip();
    if (!tip) return;
    let target = head - this.cfg.confirmations;
    if (target > tip.number) target = tip.number;
    if (target < this.cfg.startBlock) return;
    const current = this.db.getFinalized();
    if (current !== null && target <= current) return;
    this.db.finalize(target);
    this.log.debug("finalized", { upTo: target });
  }

  private async loop(): Promise<void> {
    this.log.info("indexer started", {
      contract: this.cfg.contract,
      chainId: this.cfg.chainId,
      startBlock: this.cfg.startBlock,
      confirmations: this.cfg.confirmations,
    });
    while (this.running) {
      try {
        await this.tick();
        this.lastError = null;
        this.backoffMs = 0;
      } catch (e) {
        if (e instanceof FinalityViolationError || e instanceof ProjectionError) {
          this.lastError = e.message;
          this.log.error("fatal integrity error, stopping", { error: e.message });
          this.running = false;
          this.emit("status", this.status());
          this.emit("fatal", e);
          break;
        }
        this.lastError = errorMessage(e);
        this.backoffMs = Math.min(Math.max(this.backoffMs * 2, this.cfg.pollIntervalMs), 30_000);
        const level = e instanceof AllProvidersFailedError ? "error" : "warn";
        this.log[level]("tick failed", { error: this.lastError, retryInMs: this.backoffMs });
        this.emit("status", this.status());
      }
      await this.sleep(this.backoffMs || this.cfg.pollIntervalMs);
    }
    this.log.info("indexer stopped");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }
}
