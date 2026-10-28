import { describe, expect, it } from "vitest";
import { IndexerDatabase } from "../src/db/Database.ts";
import { decodeEscrowLog } from "../src/indexer/decode.ts";
import { createdLog, FakeChain, releasedLog, resolvedLog } from "./fakes.ts";

function dec(log: ReturnType<typeof createdLog>) {
  return decodeEscrowLog(log)!;
}

describe("IndexerDatabase", () => {
  it("commits blocks + events + projection atomically and reads them back", () => {
    const db = new IndexerDatabase(":memory:");
    const chain = new FakeChain(1);
    const [b1, b2] = chain.mine(2);
    const ev = [
      dec(createdLog(chain, b1!, 0, { id: 1n, amount: 500n })),
      dec(createdLog(chain, b1!, 1, { id: 2n, amount: 700n })),
      dec(releasedLog(chain, b2!, 0, { id: 1n, payeeAmount: 500n })),
    ];
    db.commitExtend(chain.blocks, ev);

    expect(db.getTip()).toEqual(b2);
    expect(db.getBlock(1n)).toEqual(b1);
    expect(db.counts()).toEqual({ events: 3, escrows: 2, reorgs: 0 });
    expect(db.getEscrow("1")).toMatchObject({ status: "Released", payeeAmount: "500", finalized: false });
    expect(db.getEscrow("2")).toMatchObject({ status: "Active", amount: "700" });
    expect(db.listEscrows().map((e) => e.id)).toEqual(["2", "1"]);
    expect(db.listEscrows({ status: "Active" }).map((e) => e.id)).toEqual(["2"]);
    expect(db.listEvents({ escrowId: "1" }).map((e) => e.name)).toEqual(["EscrowReleased", "EscrowCreated"]);
    db.close();
  });

  it("rolls back a failed commit entirely", () => {
    const db = new IndexerDatabase(":memory:");
    const chain = new FakeChain(1);
    const [b1] = chain.mine(1);
    // Release before create is a ProjectionError -> whole transaction must roll back.
    const bad = [dec(releasedLog(chain, b1!, 0, { id: 9n, payeeAmount: 1n }))];
    expect(() => db.commitExtend(chain.blocks, bad)).toThrow();
    expect(db.getTip()).toBeNull();
    expect(db.counts().events).toBe(0);
    db.close();
  });

  it("commitReorg removes orphaned events, rebuilds affected escrows by replay and records the reorg", () => {
    const db = new IndexerDatabase(":memory:");
    const chain = new FakeChain(1);
    const [b1, b2, b3] = chain.mine(3);
    db.commitExtend(chain.blocks, [
      dec(createdLog(chain, b1!, 0, { id: 1n, amount: 500n })),
      dec(createdLog(chain, b2!, 0, { id: 2n, amount: 700n })),
      dec(releasedLog(chain, b3!, 0, { id: 1n, payeeAmount: 500n })),
      dec(resolvedLog(chain, b3!, 1, { id: 2n, payeeAmount: 100n, payerAmount: 600n })),
    ]);
    const oldTip = db.getTip()!;

    // Replace block 3 with a block that only refunds nothing: escrow 1 back to Active, escrow 2 released instead.
    const [n3, n4] = chain.reorg(3n, 2);
    const newEvents = [dec(releasedLog(chain, n4!, 0, { id: 2n, payeeAmount: 700n }))];
    const result = db.commitReorg(
      { detectedAt: 123, commonAncestor: 2n, oldTip, newTip: 4n, depth: 1 },
      [n3!, n4!],
      newEvents,
    );

    expect(result).toEqual({ eventsRemoved: 2, blocksRemoved: 1, affectedEscrows: ["1", "2"] });
    expect(db.getTip()).toEqual(n4);
    expect(db.getBlock(3n)).toEqual(n3);
    expect(db.getEscrow("1")).toMatchObject({ status: "Active", payeeAmount: "0", updatedBlock: 1 });
    expect(db.getEscrow("2")).toMatchObject({ status: "Released", payeeAmount: "700", updatedBlock: 4 });
    expect(db.counts()).toEqual({ events: 3, escrows: 2, reorgs: 1 });
    expect(db.listReorgs()[0]).toMatchObject({ commonAncestor: 2, oldTip: 3, oldTipHash: oldTip.hash, newTip: 4, depth: 1, eventsRolledBack: 2 });
    db.close();
  });

  it("finalize marks rows final and prunes headers below the finalized block", () => {
    const db = new IndexerDatabase(":memory:");
    const chain = new FakeChain(1);
    const [b1, , b3] = chain.mine(3);
    db.commitExtend(chain.blocks, [
      dec(createdLog(chain, b1!, 0, { id: 1n, amount: 1n })),
      dec(createdLog(chain, b3!, 0, { id: 2n, amount: 1n })),
    ]);

    db.finalize(2n);
    expect(db.getFinalized()).toBe(2n);
    expect(db.getBlock(1n)).toBeNull(); // pruned
    expect(db.getBlock(2n)).not.toBeNull(); // kept as reorg floor
    expect(db.getEscrow("1")!.finalized).toBe(true);
    expect(db.getEscrow("2")!.finalized).toBe(false);
    expect(db.listEvents().map((e) => e.finalized)).toEqual([false, true]);
    db.close();
  });

  it("stores and reads meta", () => {
    const db = new IndexerDatabase(":memory:");
    expect(db.getMeta("x")).toBeNull();
    db.setMeta("x", "1");
    db.setMeta("x", "2");
    expect(db.getMeta("x")).toBe("2");
    db.close();
  });
});
