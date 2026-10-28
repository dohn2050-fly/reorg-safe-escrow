import { describe, expect, it } from "vitest";
import { decodeEscrowLog } from "../src/indexer/decode.ts";
import { applyEvent, replay } from "../src/indexer/reducer.ts";
import { ProjectionError } from "../src/rpc/errors.ts";
import { ARBITER, createdLog, FakeChain, PAYEE, PAYER, refundedLog, releasedLog, resolvedLog } from "./fakes.ts";

function events(chain: FakeChain) {
  const [b1, b2, b3] = chain.mine(3);
  const created = decodeEscrowLog(createdLog(chain, b1!, 0, { id: 1n, amount: 1_000n }))!;
  const released = decodeEscrowLog(releasedLog(chain, b2!, 0, { id: 1n, payeeAmount: 1_000n }))!;
  const refunded = decodeEscrowLog(refundedLog(chain, b2!, 1, { id: 1n, payerAmount: 1_000n }))!;
  const resolved = decodeEscrowLog(resolvedLog(chain, b3!, 0, { id: 1n, payeeAmount: 400n, payerAmount: 600n }))!;
  return { created, released, refunded, resolved, b1: b1!, b2: b2!, b3: b3! };
}

describe("decode + reducer", () => {
  it("decodes EscrowCreated with indexed and non-indexed args", () => {
    const chain = new FakeChain(1);
    const { created } = events(chain);
    expect(created.name).toBe("EscrowCreated");
    expect(created.escrowId).toBe("1");
    expect(created.args).toMatchObject({ id: "1", payer: PAYER, payee: PAYEE, arbiter: ARBITER, amount: "1000" });
  });

  it("returns null for logs with an unknown signature", () => {
    const chain = new FakeChain(1);
    const [b] = chain.mine(1);
    const log = chain.addLog(b!, {
      address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      transactionHash: "0x01",
      logIndex: 0,
      data: "0x",
      topics: ["0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
    });
    expect(decodeEscrowLog(log)).toBeNull();
  });

  it("walks the lifecycle Active -> Released", () => {
    const chain = new FakeChain(1);
    const { created, released, b1, b2 } = events(chain);
    const s1 = applyEvent(undefined, created)!;
    expect(s1).toMatchObject({ id: "1", status: "Active", amount: "1000", createdBlock: Number(b1.number), payeeAmount: "0" });
    const s2 = applyEvent(s1, released)!;
    expect(s2).toMatchObject({ status: "Released", payeeAmount: "1000", payerAmount: "0", updatedBlock: Number(b2.number) });
    expect(s2.createdTx).toBe(created.txHash);
    expect(s2.updatedTx).toBe(released.txHash);
  });

  it("walks Active -> Refunded and Active -> Resolved", () => {
    const chain = new FakeChain(1);
    const { created, refunded, resolved } = events(chain);
    const base = applyEvent(undefined, created)!;
    expect(applyEvent(base, refunded)).toMatchObject({ status: "Refunded", payerAmount: "1000", payeeAmount: "0" });
    expect(applyEvent(base, resolved)).toMatchObject({ status: "Resolved", payeeAmount: "400", payerAmount: "600" });
  });

  it("rejects impossible transitions loudly instead of silently corrupting state", () => {
    const chain = new FakeChain(1);
    const { created, released, refunded } = events(chain);
    expect(() => applyEvent(undefined, released)).toThrow(ProjectionError);
    const active = applyEvent(undefined, created)!;
    expect(() => applyEvent(active, created)).toThrow(/duplicate EscrowCreated/);
    const done = applyEvent(active, released)!;
    expect(() => applyEvent(done, refunded)).toThrow(/in status Released/);
  });

  it("replay is deterministic and ignores non-projected events", () => {
    const chain = new FakeChain(1);
    const { created, released } = events(chain);
    const noise = { ...released, name: "Withdrawn", escrowId: null, args: { account: PAYEE, token: "0x0", amount: "1" } };
    const a = replay([created, noise, released]);
    const b = replay([created, noise, released]);
    expect(a).toEqual(b);
    expect(a!.status).toBe("Released");
  });
});
