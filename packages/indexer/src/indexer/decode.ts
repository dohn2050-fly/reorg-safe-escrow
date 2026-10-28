import { AbiEventSignatureNotFoundError, decodeEventLog, type Hex } from "viem";
import { escrowAbi } from "@reorg-safe/shared";
import type { RawLog } from "../rpc/types.ts";

export interface DecodedEvent {
  blockNumber: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  name: string;
  /** Escrow id as a decimal string, for events that carry one. */
  escrowId: string | null;
  /** All event arguments, serialised as strings (bigint -> decimal, addresses checksummed). */
  args: Record<string, string>;
}

function toStr(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Decode a raw log emitted by the Escrow contract. Returns null for logs whose topic0 is unknown. */
export function decodeEscrowLog(log: RawLog): DecodedEvent | null {
  let decoded: { eventName: string; args: unknown };
  try {
    decoded = decodeEventLog({
      abi: escrowAbi,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
  } catch (e) {
    if (e instanceof AbiEventSignatureNotFoundError) return null;
    throw e;
  }

  const rawArgs = (decoded.args ?? {}) as Record<string, unknown>;
  const args = Object.fromEntries(Object.entries(rawArgs).map(([k, v]) => [k, toStr(v)]));

  return {
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    name: decoded.eventName,
    escrowId: "id" in args ? (args.id ?? null) : null,
    args,
  };
}
