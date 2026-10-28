import { describe, expect, it } from "vitest";
import { ChainTracker } from "../src/chain/ChainTracker.ts";
import { PoolChainSource } from "../src/chain/PoolChainSource.ts";
import { IndexerDatabase } from "../src/db/Database.ts";
import { Indexer } from "../src/indexer/Indexer.ts";
import { silentLogger } from "../src/logger.ts";
import { FinalityViolationError } from "../src/rpc/errors.ts";
import { ProviderPool } from "../src/rpc/ProviderPool.ts";
import type { RpcClient } from "../src/rpc/types.ts";
import { CONTRACT, createdLog, FakeChain, fakeClient, refundedLog, releasedLog } from "./fakes.ts";

function build(chain: FakeChain, clients?: RpcClient[], confirmations = 2n) {
  const cls = clients ?? [fakeClient("A", () => chain), fakeClient("B", () => chain)];
  const pool = new ProviderPool(cls, { quorum: Math.min(2, cls.length) });
  const source = new PoolChainSource(pool);
  const db = new IndexerDatabase(":memory:");
  const tracker = new ChainTracker(source, { startBlock: 0n, batchSize: 100 });
  const indexer = new Indexer({
    source,
    tracker,
    db,
    logger: silentLogger,
    config: { contract: CONTRACT, chainId: 31337, startBlock: 0n, confirmations, pollIntervalMs: 10 },
    now: () => 42,
  });
  return { pool, db, indexer };
}

describe("Indexer (end-to-end against a fake chain)", () => {
  it("indexes events, then rolls back and rebuilds state after a reorg", async () => {
    const chain = new FakeChain(1);
    const [, , b3] = chain.mine(4); // 1..4
    createdLog(chain, b3!, 0, { id: 1n, amount: 1_000n });
    createdLog(chain, b3!, 1, { id: 2n, amount: 2_000n });
    const { db, indexer } = build(chain);

    await indexer.tick();
    expect(db.getTip()!.number).toBe(4n);
    expect(db.listEscrows().map((e) => [e.id, e.status])).toEqual([
      ["2", "Active"],
      ["1", "Active"],
    ]);

    const [b5] = chain.mine(1);
    releasedLog(chain, b5!, 0, { id: 1n, payeeAmount: 1_000n });
    await indexer.tick();
    expect(db.getEscrow("1")!.status).toBe("Released");

    // Reorg: block 5 is replaced; in the new history escrow 2 is refunded and escrow 1 stays Active.
    const reorgs: unknown[] = [];
    indexer.on("reorg", (r) => reorgs.push(r));
    const [n5, n6] = chain.reorg(5n, 2);
    refundedLog(chain, n5!, 0, { id: 2n, payerAmount: 2_000n });

    const plan = await indexer.tick();
    expect(plan.kind).toBe("reorg");
    expect(db.getTip()).toEqual(n6);
    expect(db.getEscrow("1")).toMatchObject({ status: "Active", payeeAmount: "0" });
    expect(db.getEscrow("2")).toMatchObject({ status: "Refunded", payerAmount: "2000", updatedBlock: 5 });
    expect(db.counts()).toEqual({ events: 3, escrows: 2, reorgs: 1 });
    expect(reorgs).toHaveLength(1);
    expect(reorgs[0]).toMatchObject({ commonAncestor: 4, oldTip: 5, newTip: 6, depth: 1, eventsRolledBack: 1 });

    const status = indexer.status();
    expect(status).toMatchObject({ localTip: 6, remoteHead: 6, lag: 0, reorgCount: 1, eventCount: 3, escrowCount: 2 });
  });

  it("finalizes blocks `confirmations` behind head and prunes the header window", async () => {
    const chain = new FakeChain(1);
    const [b1] = chain.mine(10);
    createdLog(chain, b1!, 0, { id: 1n, amount: 1n });
    const { db, indexer } = build(chain, undefined, 3n);

    await indexer.tick();
    expect(db.getFinalized()).toBe(7n);
    expect(db.getBlock(6n)).toBeNull();
    expect(db.getBlock(7n)).not.toBeNull();
    expect(db.getEscrow("1")!.finalized).toBe(true);
    expect(indexer.status().finalized).toBe(7);
  });

  it("retries log fetching on another provider when logs disagree with tracked headers", async () => {
    const canonical = new FakeChain(1);
    const [b1, b2] = canonical.mine(2);
    createdLog(canonical, b1!, 0, { id: 1n, amount: 10n });
    createdLog(canonical, b2!, 0, { id: 2n, amount: 20n });
    const fork = canonical.fork(2n, 1); // same block 1, different block 2 (no escrow 2 there)

    const bad = fakeClient("BAD", () => canonical, { logsFrom: fork }); // headers canonical, logs from a fork
    const good = fakeClient("GOOD", () => canonical);
    const { pool, db, indexer } = build(canonical, [bad, good]);

    await indexer.tick();
    expect(db.listEscrows().map((e) => e.id)).toEqual(["2", "1"]);
    expect(pool.snapshot().find((p) => p.url === "BAD")!.lastError).toMatch(/unknown block/);
  });

  it("stops with a fatal error instead of rewriting finalized history", async () => {
    const chain = new FakeChain(1);
    chain.mine(10);
    const { indexer } = build(chain, undefined, 2n);
    await indexer.tick(); // finalized = 8

    const fatal: Error[] = [];
    indexer.on("fatal", (e) => fatal.push(e));
    chain.reorg(5n, 8); // divergence below finality

    indexer.start();
    await new Promise((r) => setTimeout(r, 50));
    await indexer.stop();

    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toBeInstanceOf(FinalityViolationError);
    expect(indexer.status().lastError).toMatch(/finalized/);
    expect(indexer.isRunning).toBe(false);
  });

  it("keeps running through a total provider outage and resumes afterwards", async () => {
    const chain = new FakeChain(3);
    let down = false;
    const a = fakeClient("A", () => chain, { fail: () => down });
    const { db, indexer } = build(chain, [a]);

    await indexer.tick();
    down = true;
    await expect(indexer.tick()).rejects.toThrow(/all providers failed/);
    down = false;
    chain.mine(2);
    await indexer.tick();
    expect(db.getTip()!.number).toBe(4n);
  });
});
