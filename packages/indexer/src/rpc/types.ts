import type { Address, Hex } from "viem";

export interface BlockHeader {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
}

export interface RawLog {
  address: Address;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  data: Hex;
  topics: readonly Hex[];
  removed: boolean;
}

export interface GetLogsArgs {
  address: Address;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface GetLogsByHashArgs {
  address: Address;
  blockHash: Hex;
}

/**
 * The narrow JSON-RPC surface the indexer needs. Kept deliberately small so that tests can
 * substitute deterministic fakes and so that swapping viem for another client is trivial.
 */
export interface RpcClient {
  readonly url: string;
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  /** Resolves `null` when the node does not know a block at that height. */
  getBlock(number: bigint): Promise<BlockHeader | null>;
  getLogs(args: GetLogsArgs): Promise<RawLog[]>;
  /** EIP-234 filter: logs of exactly this block. Must reject if the node does not know the hash. */
  getLogsByBlockHash(args: GetLogsByHashArgs): Promise<RawLog[]>;
}

/** A value plus the provider that produced it, so callers can attribute bad data. */
export interface Attributed<T> {
  value: T;
  url: string;
}

export interface CanonicalVote {
  /** Majority hash at the queried height; `null` when the majority says the block does not exist. */
  hash: Hex | null;
  /** True when a strict majority of responding providers agree. */
  consensus: boolean;
  votes: Array<{ url: string; hash: Hex | null }>;
}
