import { createHash } from "node:crypto";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Address, type Hex } from "viem";
import { escrowAbi } from "@reorg-safe/shared";
import type { LocalChainView, SyncPlan } from "../src/chain/ChainTracker.ts";
import type { BlockHeader, GetLogsArgs, GetLogsByHashArgs, RawLog, RpcClient } from "../src/rpc/types.ts";

export const CONTRACT: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const PAYER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const PAYEE: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const ARBITER: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const ZERO: Address = "0x0000000000000000000000000000000000000000";

function h(input: string): Hex {
  return `0x${createHash("sha256").update(input).digest("hex")}`;
}

/**
 * An in-memory canonical chain with deterministic hashes. Supports mining, forking (reorg) and
 * head rollback (like `evm_revert`). Logs are attached per block.
 */
export class FakeChain {
  blocks: BlockHeader[] = [];
  private logs = new Map<Hex, RawLog[]>();
  private salt = 0;

  constructor(initialLength = 1) {
    this.mine(initialLength);
  }

  get head(): bigint {
    return BigInt(this.blocks.length - 1);
  }

  block(n: bigint): BlockHeader | null {
    return this.blocks[Number(n)] ?? null;
  }

  mine(count = 1): BlockHeader[] {
    const out: BlockHeader[] = [];
    for (let i = 0; i < count; i++) {
      const number = BigInt(this.blocks.length);
      const parentHash = this.blocks[this.blocks.length - 1]?.hash ?? h("genesis-parent");
      const hash = h(`${parentHash}:${number}:${this.salt++}`);
      const b = { number, hash, parentHash, timestamp: 1_700_000_000n + number * 12n };
      this.blocks.push(b);
      out.push(b);
    }
    return out;
  }

  /** Drop blocks >= `from` and mine `count` replacements with new hashes. Returns the new blocks. */
  reorg(from: bigint, count: number): BlockHeader[] {
    this.revertTo(from - 1n);
    return this.mine(count);
  }

  /** Truncate the chain so that `to` is the head (removes logs of dropped blocks). */
  revertTo(to: bigint): void {
    const dropped = this.blocks.splice(Number(to) + 1);
    for (const b of dropped) this.logs.delete(b.hash);
  }

  /** Create a fork of this chain starting at `from` (blocks >= from get different hashes). */
  fork(from: bigint, count: number): FakeChain {
    const f = new FakeChain(0);
    f.blocks = this.blocks.slice(0, Number(from));
    for (const b of f.blocks) {
      const l = this.logs.get(b.hash);
      if (l) f.logs.set(b.hash, l);
    }
    f.salt = 1_000_000 + this.salt;
    f.mine(count);
    return f;
  }

  addLog(block: BlockHeader, log: Omit<RawLog, "blockNumber" | "blockHash" | "removed">): RawLog {
    const full: RawLog = { ...log, blockNumber: block.number, blockHash: block.hash, removed: false };
    const list = this.logs.get(block.hash) ?? [];
    list.push(full);
    this.logs.set(block.hash, list);
    return full;
  }

  getLogs({ address, fromBlock, toBlock }: GetLogsArgs): RawLog[] {
    const out: RawLog[] = [];
    for (let n = fromBlock; n <= toBlock && n <= this.head; n++) {
      const b = this.blocks[Number(n)]!;
      for (const l of this.logs.get(b.hash) ?? []) if (l.address.toLowerCase() === address.toLowerCase()) out.push(l);
    }
    return out;
  }

  /** Like eth_getLogs with a blockHash filter: errors when this chain does not contain the block. */
  getLogsByHash({ address, blockHash }: GetLogsByHashArgs): RawLog[] {
    if (!this.blocks.some((b) => b.hash === blockHash)) throw new Error(`unknown block ${blockHash.slice(0, 10)}`);
    return (this.logs.get(blockHash) ?? []).filter((l) => l.address.toLowerCase() === address.toLowerCase());
  }
}

export interface FakeClientOptions {
  /** Return true to make the next call throw. */
  fail?: () => boolean;
  /** Serve logs from a different chain than headers (simulates a provider on another fork for eth_getLogs). */
  logsFrom?: FakeChain;
  /** Report head lower than the real head. */
  headOffset?: bigint;
  chainId?: number;
}

export function fakeClient(url: string, chain: () => FakeChain, opts: FakeClientOptions = {}): RpcClient & { calls: number } {
  const maybeFail = () => {
    if (opts.fail?.()) throw new Error(`${url} unavailable`);
  };
  const client = {
    url,
    calls: 0,
    async getChainId() {
      client.calls++;
      maybeFail();
      return opts.chainId ?? 31337;
    },
    async getBlockNumber() {
      client.calls++;
      maybeFail();
      return chain().head - (opts.headOffset ?? 0n);
    },
    async getBlock(n: bigint) {
      client.calls++;
      maybeFail();
      return chain().block(n);
    },
    async getLogs(args: GetLogsArgs) {
      client.calls++;
      maybeFail();
      return (opts.logsFrom ?? chain()).getLogs(args);
    },
    async getLogsByBlockHash(args: GetLogsByHashArgs) {
      client.calls++;
      maybeFail();
      return (opts.logsFrom ?? chain()).getLogsByHash(args);
    },
  };
  return client;
}

/** In-memory LocalChainView that applies SyncPlans, for ChainTracker tests. */
export class MemoryLocal implements LocalChainView {
  blocks = new Map<bigint, BlockHeader>();
  finalized: bigint | null = null;

  get tip(): BlockHeader | null {
    let best: BlockHeader | null = null;
    for (const b of this.blocks.values()) if (!best || b.number > best.number) best = b;
    return best;
  }

  getBlock(n: bigint): BlockHeader | null {
    return this.blocks.get(n) ?? null;
  }

  apply(plan: SyncPlan): void {
    if (plan.kind === "idle") return;
    if (plan.kind === "reorg") {
      for (const n of [...this.blocks.keys()]) if (n > plan.commonAncestor) this.blocks.delete(n);
    }
    for (const b of plan.blocks) this.blocks.set(b.number, b);
  }
}

// ------------------------------------------------------------------ encoded Escrow logs

let txCounter = 0;
function nextTx(): Hex {
  return h(`tx:${txCounter++}`);
}

export function createdLog(
  chain: FakeChain,
  block: BlockHeader,
  logIndex: number,
  a: { id: bigint; payer?: Address; payee?: Address; arbiter?: Address; token?: Address; amount: bigint; deadline?: bigint },
): RawLog {
  const topics = encodeEventTopics({
    abi: escrowAbi,
    eventName: "EscrowCreated",
    args: { id: a.id, payer: a.payer ?? PAYER, payee: a.payee ?? PAYEE },
  });
  const data = encodeAbiParameters(parseAbiParameters("address, address, uint256, uint64"), [
    a.arbiter ?? ARBITER,
    a.token ?? ZERO,
    a.amount,
    a.deadline ?? 1_800_000_000n,
  ]);
  return chain.addLog(block, { address: CONTRACT, transactionHash: nextTx(), logIndex, data, topics: topics as Hex[] });
}

export function releasedLog(chain: FakeChain, block: BlockHeader, logIndex: number, a: { id: bigint; by?: Address; payeeAmount: bigint }): RawLog {
  const topics = encodeEventTopics({ abi: escrowAbi, eventName: "EscrowReleased", args: { id: a.id, by: a.by ?? PAYER } });
  const data = encodeAbiParameters(parseAbiParameters("uint256"), [a.payeeAmount]);
  return chain.addLog(block, { address: CONTRACT, transactionHash: nextTx(), logIndex, data, topics: topics as Hex[] });
}

export function refundedLog(chain: FakeChain, block: BlockHeader, logIndex: number, a: { id: bigint; by?: Address; payerAmount: bigint }): RawLog {
  const topics = encodeEventTopics({ abi: escrowAbi, eventName: "EscrowRefunded", args: { id: a.id, by: a.by ?? PAYER } });
  const data = encodeAbiParameters(parseAbiParameters("uint256"), [a.payerAmount]);
  return chain.addLog(block, { address: CONTRACT, transactionHash: nextTx(), logIndex, data, topics: topics as Hex[] });
}

export function resolvedLog(
  chain: FakeChain,
  block: BlockHeader,
  logIndex: number,
  a: { id: bigint; arbiter?: Address; payeeAmount: bigint; payerAmount: bigint },
): RawLog {
  const topics = encodeEventTopics({ abi: escrowAbi, eventName: "EscrowResolved", args: { id: a.id, arbiter: a.arbiter ?? ARBITER } });
  const data = encodeAbiParameters(parseAbiParameters("uint256, uint256"), [a.payeeAmount, a.payerAmount]);
  return chain.addLog(block, { address: CONTRACT, transactionHash: nextTx(), logIndex, data, topics: topics as Hex[] });
}
