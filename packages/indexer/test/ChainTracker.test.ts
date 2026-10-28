import { describe, expect, it } from "vitest";
import { ChainTracker } from "../src/chain/ChainTracker.ts";
import { PoolChainSource } from "../src/chain/PoolChainSource.ts";
import { FinalityViolationError } from "../src/rpc/errors.ts";
import { ProviderPool } from "../src/rpc/ProviderPool.ts";
import type { RpcClient } from "../src/rpc/types.ts";
import { FakeChain, fakeClient, MemoryLocal } from "./fakes.ts";

function setup(chain: FakeChain, clients?: RpcClient[], opts: { startBlock?: bigint; batchSize?: number; quorum?: number } = {}) {
  const cls = clients ?? [fakeClient("A", () => chain), fakeClient("B", () => chain)];
  const pool = new ProviderPool(cls, { quorum: opts.quorum ?? cls.length });
  const source = new PoolChainSource(pool);
  const tracker = new ChainTracker(source, { startBlock: opts.startBlock ?? 0n, batchSize: opts.batchSize ?? 100 });
  const local = new MemoryLocal();
  return { pool, tracker, local };
}

async function sync(tracker: ChainTracker, local: MemoryLocal) {
  const plan = await tracker.plan(local);
  local.apply(plan);
  return plan;
}

describe("ChainTracker", () => {
  it("cold-starts from START_BLOCK in batches", async () => {
    const chain = new FakeChain(25);
    const { tracker, local } = setup(chain, undefined, { startBlock: 5n, batchSize: 10 });

    const p1 = await sync(tracker, local);
    expect(p1.kind).toBe("extend");
    expect(local.tip!.number).toBe(14n);
    expect(local.getBlock(4n)).toBeNull();

    const p2 = await sync(tracker, local);
    expect(p2.kind).toBe("extend");
    expect(local.tip!.number).toBe(24n);

    const p3 = await sync(tracker, local);
    expect(p3.kind).toBe("idle");
  });

  it("extends as new blocks are mined and stays idle otherwise", async () => {
    const chain = new FakeChain(5);
    const { tracker, local } = setup(chain);
    await sync(tracker, local);
    expect(local.tip!.number).toBe(4n);

    expect((await sync(tracker, local)).kind).toBe("idle");
    chain.mine(3);
    const p = await sync(tracker, local);
    expect(p.kind).toBe("extend");
    expect(p.kind === "extend" && p.blocks.map((b) => b.number)).toEqual([5n, 6n, 7n]);
    expect(local.tip!.hash).toBe(chain.block(7n)!.hash);
  });

  it("detects a reorg from a parent-hash mismatch and finds the common ancestor", async () => {
    const chain = new FakeChain(11); // 0..10
    const { tracker, local } = setup(chain);
    await sync(tracker, local);
    const oldTip = local.tip!;

    chain.reorg(8n, 4); // new 8',9',10',11'
    const plan = await sync(tracker, local);

    expect(plan.kind).toBe("reorg");
    if (plan.kind !== "reorg") return;
    expect(plan.commonAncestor).toBe(7n);
    expect(plan.depth).toBe(3);
    expect(plan.oldTip).toEqual(oldTip);
    expect(plan.blocks.map((b) => b.number)).toEqual([8n, 9n, 10n, 11n]);
    expect(local.tip!.hash).toBe(chain.block(11n)!.hash);
    expect(local.getBlock(8n)!.hash).toBe(chain.block(8n)!.hash);
    expect(local.getBlock(7n)!.hash).toBe(chain.block(7n)!.hash);
  });

  it("handles the head moving backwards (devnet revert) as a reorg", async () => {
    const chain = new FakeChain(11);
    const { tracker, local } = setup(chain);
    await sync(tracker, local);

    chain.revertTo(6n);
    chain.mine(1); // head is now 7, hash differs from our old 7
    const plan = await sync(tracker, local);
    expect(plan.kind).toBe("reorg");
    if (plan.kind !== "reorg") return;
    expect(plan.commonAncestor).toBe(6n);
    expect(plan.depth).toBe(4);
    expect(plan.blocks.map((b) => b.number)).toEqual([7n]);
    expect(local.tip!.number).toBe(7n);
  });

  it("stays idle when the head is behind us but our tip is still canonical (lagging provider)", async () => {
    const chain = new FakeChain(11);
    const lagging = fakeClient("L", () => chain, { headOffset: 3n });
    const { tracker, local } = setup(chain, [lagging], { quorum: 1 });
    // Pretend we already synced to the true tip.
    for (const b of chain.blocks) local.blocks.set(b.number, b);

    const plan = await sync(tracker, local);
    expect(plan.kind).toBe("idle");
    expect(plan.kind === "idle" && plan.reason).toMatch(/tip canonical/);
    expect(local.tip!.number).toBe(10n);
  });

  it("penalises a provider that serves a non-canonical block instead of reorging", async () => {
    const canonical = new FakeChain(10); // 0..9
    const fork = canonical.fork(9n, 3); // 9',10',11'
    const bad = fakeClient("BAD", () => fork);
    const a = fakeClient("A", () => canonical);
    const b = fakeClient("B", () => canonical);
    // BAD is first so it is tried first for single-provider calls while quorum votes are 2:1 against it.
    const { pool, tracker, local } = setup(canonical, [bad, a, b], { quorum: 3 });
    await sync(tracker, local); // may already pick up canonical blocks; make sure we're at 9 canonical
    for (const bk of canonical.blocks) local.blocks.set(bk.number, bk);
    for (const n of [...local.blocks.keys()]) if (n > 9n) local.blocks.delete(n);

    canonical.mine(1); // canonical 10 exists; BAD still says head 11 and serves 10'
    const plan = await tracker.plan(local);
    expect(plan.kind).toBe("idle");
    expect(plan.kind === "idle" && plan.reason).toMatch(/non-canonical/);
    expect(pool.snapshot().find((p) => p.url === "BAD")!.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(local.tip!.hash).toBe(canonical.block(9n)!.hash);
  });

  it("returns idle instead of acting when providers have no consensus", async () => {
    const canonical = new FakeChain(10);
    const fork = canonical.fork(8n, 2);
    const a = fakeClient("A", () => canonical);
    const b = fakeClient("B", () => fork);
    const { tracker, local } = setup(canonical, [a, b], { quorum: 2 });
    for (const bk of canonical.blocks) local.blocks.set(bk.number, bk);

    const plan = await tracker.plan(local);
    expect(plan.kind).toBe("idle");
    expect(plan.kind === "idle" && plan.reason).toMatch(/no quorum/);
  });

  it("refuses to roll back below the finalized block", async () => {
    const chain = new FakeChain(11);
    const { tracker, local } = setup(chain);
    await sync(tracker, local);
    local.finalized = 8n;

    chain.reorg(7n, 5); // diverges below finality
    await expect(tracker.plan(local)).rejects.toBeInstanceOf(FinalityViolationError);
  });

  it("allows a reorg that touches exactly the first unfinalized block", async () => {
    const chain = new FakeChain(11);
    const { tracker, local } = setup(chain);
    await sync(tracker, local);
    local.finalized = 8n;

    chain.reorg(9n, 2);
    const plan = await sync(tracker, local);
    expect(plan.kind).toBe("reorg");
    expect(plan.kind === "reorg" && plan.commonAncestor).toBe(8n);
  });

  it("truncates a batch at the first non-linking block (reorg during fetch)", async () => {
    const canonical = new FakeChain(5); // 0..4
    const fork = canonical.fork(3n, 4); // 3',4',5',6'
    let serveFork = false;
    // Blocks >= 4 come from the fork once `serveFork` flips, simulating a provider switching mid-batch.
    const flaky: RpcClient = {
      url: "F",
      getChainId: async () => 31337,
      getBlockNumber: async () => fork.head,
      getBlock: async (n) => (serveFork && n >= 4n ? fork.block(n) : canonical.block(n)),
      getLogs: async () => [],
      getLogsByBlockHash: async () => [],
    };
    const { pool, tracker, local } = setup(canonical, [flaky], { quorum: 1, batchSize: 10 });
    serveFork = true;
    const plan = await sync(tracker, local);
    expect(plan.kind).toBe("extend");
    // 0..3 are canonical and link; 4' does not link to 3 -> truncated there.
    expect(plan.kind === "extend" && plan.blocks.map((b) => b.number)).toEqual([0n, 1n, 2n, 3n]);
    expect(pool.snapshot()[0]!.consecutiveFailures).toBe(1);
  });
});
