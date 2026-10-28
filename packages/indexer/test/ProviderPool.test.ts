import { describe, expect, it } from "vitest";
import { AllProvidersFailedError } from "../src/rpc/errors.ts";
import { ProviderPool } from "../src/rpc/ProviderPool.ts";
import { FakeChain, fakeClient } from "./fakes.ts";

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("ProviderPool", () => {
  it("fails over to the next provider when the first one errors", async () => {
    const chain = new FakeChain(5);
    const a = fakeClient("A", () => chain, { fail: () => true });
    const b = fakeClient("B", () => chain);
    const pool = new ProviderPool([a, b], { quorum: 1 });

    const { value, url } = await pool.call("blockNumber", (c) => c.getBlockNumber());
    expect(value).toBe(4n);
    expect(url).toBe("B");

    const snap = pool.snapshot();
    expect(snap[0]!.url).toBe("B"); // healthy provider ranks first
    expect(snap.find((p) => p.url === "A")!.consecutiveFailures).toBe(1);
  });

  it("throws AllProvidersFailedError with per-provider causes when nothing works", async () => {
    const chain = new FakeChain(5);
    const a = fakeClient("A", () => chain, { fail: () => true });
    const b = fakeClient("B", () => chain, { fail: () => true });
    const pool = new ProviderPool([a, b]);

    await expect(pool.call("blockNumber", (c) => c.getBlockNumber())).rejects.toBeInstanceOf(AllProvidersFailedError);
    await expect(pool.call("blockNumber", (c) => c.getBlockNumber())).rejects.toThrow(/A -> A unavailable; B -> B unavailable/);
  });

  it("opens the circuit after the failure threshold, backs off, probes, and recovers", async () => {
    const chain = new FakeChain(5);
    const c = clock();
    let aDown = true;
    const a = fakeClient("A", () => chain, { fail: () => aDown });
    const b = fakeClient("B", () => chain);
    const pool = new ProviderPool([a, b], { failureThreshold: 2, openBaseMs: 5_000, now: c.now, quorum: 1 });

    const opened: string[] = [];
    pool.on("circuit-open", (e) => opened.push(e.url));

    // First failure: A is retried on the next call only if it still ranks first, so pin it with `exclude`.
    const onlyA = new Set(["B"]);
    await expect(pool.call("x", (cl) => cl.getBlockNumber(), onlyA)).rejects.toBeInstanceOf(AllProvidersFailedError);
    expect(pool.snapshot().find((p) => p.url === "A")!.state).toBe("closed");
    await expect(pool.call("x", (cl) => cl.getBlockNumber(), onlyA)).rejects.toBeInstanceOf(AllProvidersFailedError);
    expect(opened).toEqual(["A"]);
    expect(pool.snapshot().find((p) => p.url === "A")!.state).toBe("open");

    // While open, A is not even tried when a healthy provider exists.
    const aCallsBefore = a.calls;
    const r0 = await pool.call("x", (cl) => cl.getBlockNumber());
    expect(r0.url).toBe("B");
    expect(a.calls).toBe(aCallsBefore);

    // After the open window A becomes half-open and is probed (ranked after healthy B though).
    c.advance(5_001);
    expect(pool.snapshot().find((p) => p.url === "A")!.state).toBe("half-open");
    aDown = false;
    // Force the probe by excluding B.
    const r = await pool.call("x", (cl) => cl.getBlockNumber(), new Set(["B"]));
    expect(r.url).toBe("A");
    expect(pool.snapshot().find((p) => p.url === "A")!.state).toBe("closed");
  });

  it("doubles the open duration on repeated failures up to the cap", async () => {
    const chain = new FakeChain(5);
    const c = clock();
    const a = fakeClient("A", () => chain, { fail: () => true });
    const b = fakeClient("B", () => chain);
    const pool = new ProviderPool([a, b], { failureThreshold: 1, openBaseMs: 1_000, openMaxMs: 3_000, now: c.now, quorum: 1 });

    const durations: number[] = [];
    pool.on("circuit-open", (e) => durations.push(e.until - c.now()));

    for (let i = 0; i < 4; i++) {
      await pool.call("x", (cl) => cl.getBlockNumber(), new Set(["B"])).catch(() => undefined);
      c.advance(10_000); // let it go half-open again
    }
    expect(durations).toEqual([1_000, 2_000, 3_000, 3_000]);
  });

  it("getHead returns the best head and flags lagging providers", async () => {
    const chain = new FakeChain(101);
    const a = fakeClient("A", () => chain, { headOffset: 5n });
    const b = fakeClient("B", () => chain);
    const pool = new ProviderPool([a, b], { quorum: 2, lagTolerance: 2n });

    const lagging: string[] = [];
    pool.on("lagging", (e) => lagging.push(e.url));

    expect(await pool.getHead()).toBe(100n);
    expect(lagging).toEqual(["A"]);
    const snap = pool.snapshot();
    expect(snap.find((p) => p.url === "A")!.lagging).toBe(true);
    expect(snap.find((p) => p.url === "A")!.lastHead).toBe(95);
    expect(snap[0]!.url).toBe("B"); // lagging providers rank last
  });

  it("canonicalHash reports consensus only for a strict majority", async () => {
    const canonical = new FakeChain(10);
    const fork = canonical.fork(8n, 2);
    const a = fakeClient("A", () => canonical);
    const b = fakeClient("B", () => fork);
    const c = fakeClient("C", () => canonical);

    // Two providers that disagree: no consensus.
    const two = new ProviderPool([a, b], { quorum: 2 });
    const v2 = await two.canonicalHash(9n);
    expect(v2.consensus).toBe(false);
    expect(v2.hash).toBeNull();

    // Agreement below the fork point.
    const v2ok = await two.canonicalHash(7n);
    expect(v2ok.consensus).toBe(true);
    expect(v2ok.hash).toBe(canonical.block(7n)!.hash);

    // Three providers, two agree: consensus for the canonical hash.
    const three = new ProviderPool([a, b, c], { quorum: 3 });
    const v3 = await three.canonicalHash(9n);
    expect(v3.consensus).toBe(true);
    expect(v3.hash).toBe(canonical.block(9n)!.hash);

    // Majority says the block does not exist.
    const v3none = await three.canonicalHash(50n);
    expect(v3none.consensus).toBe(true);
    expect(v3none.hash).toBeNull();
  });

  it("penalize counts as a failure and can open the circuit", async () => {
    const chain = new FakeChain(5);
    const a = fakeClient("A", () => chain);
    const b = fakeClient("B", () => chain);
    const pool = new ProviderPool([a, b], { failureThreshold: 2 });
    pool.penalize("A", "served a bad block");
    pool.penalize("A", "served another bad block");
    const snap = pool.snapshot().find((p) => p.url === "A")!;
    expect(snap.state).toBe("open");
    expect(snap.lastError).toMatch(/inconsistent data/);
  });
});
