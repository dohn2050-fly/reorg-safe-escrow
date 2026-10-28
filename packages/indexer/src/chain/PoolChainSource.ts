import type { ProviderPool } from "../rpc/ProviderPool.ts";
import type { Attributed, BlockHeader, CanonicalVote, GetLogsArgs, GetLogsByHashArgs, RawLog } from "../rpc/types.ts";
import type { ChainSource } from "./ChainTracker.ts";

export interface LogSource {
  getLogs(args: GetLogsArgs, exclude?: ReadonlySet<string>): Promise<Attributed<RawLog[]>>;
  getLogsByBlockHash(args: GetLogsByHashArgs, exclude?: ReadonlySet<string>): Promise<Attributed<RawLog[]>>;
}

/** Adapts a ProviderPool to the ChainSource/LogSource interfaces used by the tracker and indexer. */
export class PoolChainSource implements ChainSource, LogSource {
  constructor(private readonly pool: ProviderPool) {}

  getHead(): Promise<bigint> {
    return this.pool.getHead();
  }

  getBlock(number: bigint): Promise<Attributed<BlockHeader | null>> {
    return this.pool.call(`eth_getBlockByNumber(${number})`, (c) => c.getBlock(number));
  }

  canonicalHash(number: bigint): Promise<CanonicalVote> {
    return this.pool.canonicalHash(number);
  }

  penalize(url: string, reason: string): void {
    this.pool.penalize(url, reason);
  }

  getLogs(args: GetLogsArgs, exclude?: ReadonlySet<string>): Promise<Attributed<RawLog[]>> {
    return this.pool.call(`eth_getLogs(${args.fromBlock}-${args.toBlock})`, (c) => c.getLogs(args), exclude);
  }

  getLogsByBlockHash(args: GetLogsByHashArgs, exclude?: ReadonlySet<string>): Promise<Attributed<RawLog[]>> {
    return this.pool.call(`eth_getLogs(${args.blockHash.slice(0, 10)})`, (c) => c.getLogsByBlockHash(args), exclude);
  }
}
