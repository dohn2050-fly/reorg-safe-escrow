import { FinalityViolationError } from "../rpc/errors.ts";
import type { Attributed, BlockHeader, CanonicalVote } from "../rpc/types.ts";

/** What the tracker needs from the network. Implemented by PoolChainSource; faked in tests. */
export interface ChainSource {
  getHead(): Promise<bigint>;
  getBlock(number: bigint): Promise<Attributed<BlockHeader | null>>;
  canonicalHash(number: bigint): Promise<CanonicalVote>;
  penalize(url: string, reason: string): void;
}

/** What the tracker needs from local storage. */
export interface LocalChainView {
  tip: BlockHeader | null;
  /** Highest block number considered final, or null if nothing is final yet. */
  finalized: bigint | null;
  getBlock(number: bigint): BlockHeader | null;
}

export type SyncPlan =
  | { kind: "idle"; head: bigint; reason: string }
  | { kind: "extend"; head: bigint; blocks: BlockHeader[] }
  | {
      kind: "reorg";
      head: bigint;
      commonAncestor: bigint;
      oldTip: BlockHeader;
      depth: number;
      blocks: BlockHeader[];
    };

export interface ChainTrackerOptions {
  startBlock: bigint;
  batchSize: number;
  /** Parallelism for header fetches within a batch. */
  concurrency?: number;
}

/**
 * Decides how the local header chain must change to follow the canonical chain.
 *
 * The tracker never mutates anything: it returns a SyncPlan that the indexer commits atomically.
 * Reorg handling:
 *   1. A parent-hash mismatch (or the head moving backwards) is only a *suspicion*.
 *   2. The suspicion is confirmed by asking the provider quorum for the canonical hash of our tip.
 *      If the quorum still agrees with us, the provider that served the odd block is penalised
 *      and nothing else happens.
 *   3. On a confirmed reorg we walk back one block at a time until local and canonical hashes
 *      agree, never below the finalized block. Crossing finality is a fatal integrity error.
 */
export class ChainTracker {
  private readonly startBlock: bigint;
  private readonly batchSize: bigint;
  private readonly concurrency: number;

  constructor(
    private readonly source: ChainSource,
    opts: ChainTrackerOptions,
  ) {
    this.startBlock = opts.startBlock;
    this.batchSize = BigInt(opts.batchSize);
    this.concurrency = opts.concurrency ?? 8;
  }

  async plan(local: LocalChainView): Promise<SyncPlan> {
    const head = await this.source.getHead();
    const tip = local.tip;

    // Cold start: nothing local yet.
    if (tip === null) {
      if (head < this.startBlock) return { kind: "idle", head, reason: "head below START_BLOCK" };
      const blocks = await this.fetchRange(this.startBlock, min(head, this.startBlock + this.batchSize - 1n));
      if (blocks.length === 0) return { kind: "idle", head, reason: "start block not yet available" };
      return { kind: "extend", head, blocks: strip(blocks) };
    }

    // Head did not advance (or went backwards): confirm our tip is still canonical.
    if (head <= tip.number) {
      const vote = await this.source.canonicalHash(tip.number);
      if (!vote.consensus) return { kind: "idle", head, reason: "no quorum on tip hash" };
      if (vote.hash === tip.hash) return { kind: "idle", head, reason: "tip canonical, no new blocks" };
      return this.planReorg(local, head, tip);
    }

    // Head advanced: fetch the next contiguous range.
    const blocks = await this.fetchRange(tip.number + 1n, min(head, tip.number + this.batchSize));
    if (blocks.length === 0) return { kind: "idle", head, reason: "next block not yet available" };

    const first = blocks[0]!;
    if (first.value.parentHash !== tip.hash) {
      const vote = await this.source.canonicalHash(tip.number);
      if (!vote.consensus) return { kind: "idle", head, reason: "no quorum on tip hash" };
      if (vote.hash === tip.hash) {
        // Quorum says our tip is fine, so the provider that served `first` is on another fork.
        this.source.penalize(first.url, `block ${first.value.number} parent ${first.value.parentHash} != canonical tip ${tip.hash}`);
        return { kind: "idle", head, reason: `provider ${first.url} served non-canonical block` };
      }
      return this.planReorg(local, head, tip);
    }

    return { kind: "extend", head, blocks: strip(blocks) };
  }

  private async planReorg(local: LocalChainView, head: bigint, tip: BlockHeader): Promise<SyncPlan> {
    const floor = local.finalized ?? this.startBlock - 1n; // we may rewind down to (but not including) this
    let ancestor: bigint | null = null;

    for (let n = tip.number - 1n; n > floor; n--) {
      const localBlock = local.getBlock(n);
      if (!localBlock) break; // header window pruned; treat like reaching the floor
      const vote = await this.source.canonicalHash(n);
      if (!vote.consensus) return { kind: "idle", head, reason: `no quorum on hash of block ${n}` };
      if (vote.hash === localBlock.hash) {
        ancestor = n;
        break;
      }
    }

    if (ancestor === null) {
      // Divergence reaches the floor. If the floor is a finalized block it must still be canonical.
      if (local.finalized !== null) {
        const fb = local.getBlock(local.finalized);
        const vote = await this.source.canonicalHash(local.finalized);
        if (!vote.consensus) return { kind: "idle", head, reason: "no quorum on finalized hash" };
        if (!fb || vote.hash !== fb.hash) throw new FinalityViolationError(local.finalized, local.finalized);
      }
      ancestor = floor;
    }

    const blocks = await this.fetchRange(ancestor + 1n, min(head, ancestor + this.batchSize));
    if (blocks.length === 0) return { kind: "idle", head, reason: "reorg detected but replacement blocks not yet available" };

    // The replacement chain must attach to the ancestor we just agreed on.
    const anchor = local.getBlock(ancestor);
    if (anchor && blocks[0]!.value.parentHash !== anchor.hash) {
      return { kind: "idle", head, reason: "chain moved again while planning reorg; retrying" };
    }

    return {
      kind: "reorg",
      head,
      commonAncestor: ancestor,
      oldTip: tip,
      depth: Number(tip.number - ancestor),
      blocks: strip(blocks),
    };
  }

  /**
   * Fetch headers [from, to] in parallel and return the longest parent-linked prefix. Blocks may
   * come from different providers (failover mid-batch), so internal linkage is re-verified here.
   */
  private async fetchRange(from: bigint, to: bigint): Promise<Attributed<BlockHeader>[]> {
    const numbers: bigint[] = [];
    for (let n = from; n <= to; n++) numbers.push(n);

    const fetched: Array<Attributed<BlockHeader | null>> = [];
    for (let i = 0; i < numbers.length; i += this.concurrency) {
      const chunk = numbers.slice(i, i + this.concurrency);
      const results = await Promise.all(chunk.map((n) => this.source.getBlock(n)));
      fetched.push(...results);
      if (results.some((r) => r.value === null)) break; // ran past the provider's head
    }

    const out: Attributed<BlockHeader>[] = [];
    for (const r of fetched) {
      if (r.value === null) break;
      const prev = out[out.length - 1];
      if (prev && (r.value.parentHash !== prev.value.hash || r.value.number !== prev.value.number + 1n)) {
        this.source.penalize(r.url, `block ${r.value.number} does not link to ${prev.value.number} ${prev.value.hash}`);
        break; // keep the consistent prefix; the rest is re-fetched next tick
      }
      out.push({ value: r.value, url: r.url });
    }
    return out;
  }
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function strip(blocks: Attributed<BlockHeader>[]): BlockHeader[] {
  return blocks.map((b) => b.value);
}
