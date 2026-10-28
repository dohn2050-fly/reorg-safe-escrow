import { BlockNotFoundError, createPublicClient, http, type Log } from "viem";
import type { RawLog, RpcClient } from "./types.ts";

/**
 * Wraps a viem PublicClient as an RpcClient. viem's own retry/fallback is disabled on purpose:
 * failover decisions belong to the ProviderPool so that they are observable and testable.
 */
export function createViemRpcClient(url: string, opts: { timeoutMs: number }): RpcClient {
  const client = createPublicClient({
    transport: http(url, { timeout: opts.timeoutMs, retryCount: 0, batch: false }),
    cacheTime: 0,
  });

  return {
    url,
    getChainId: () => client.getChainId(),
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    async getBlock(number) {
      try {
        const b = await client.getBlock({ blockNumber: number, includeTransactions: false });
        if (b.number === null || b.hash === null) return null; // pending block shape; never canonical
        return { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp };
      } catch (e) {
        if (e instanceof BlockNotFoundError) return null;
        throw e;
      }
    },
    async getLogs({ address, fromBlock, toBlock }) {
      const logs = await client.getLogs({ address, fromBlock, toBlock });
      return logs.flatMap(toRawLog);
    },
    async getLogsByBlockHash({ address, blockHash }) {
      const logs = await client.getLogs({ address, blockHash });
      return logs.flatMap(toRawLog);
    },
  };
}

/** Pending logs (null block fields) are never part of a mined block and are dropped. */
function toRawLog(l: Log): RawLog[] {
  if (l.blockNumber === null || l.blockHash === null || l.transactionHash === null || l.logIndex === null) return [];
  return [
    {
      address: l.address,
      blockNumber: l.blockNumber,
      blockHash: l.blockHash,
      transactionHash: l.transactionHash,
      logIndex: l.logIndex,
      data: l.data,
      topics: l.topics,
      removed: l.removed,
    },
  ];
}
