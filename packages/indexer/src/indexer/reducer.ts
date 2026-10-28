import type { EscrowStatus } from "@reorg-safe/shared";
import { ProjectionError } from "../rpc/errors.ts";
import type { DecodedEvent } from "./decode.ts";

export interface EscrowRow {
  id: string;
  payer: string;
  payee: string;
  arbiter: string;
  token: string;
  amount: string;
  deadline: number;
  status: EscrowStatus;
  payeeAmount: string;
  payerAmount: string;
  createdBlock: number;
  updatedBlock: number;
  createdTx: string;
  updatedTx: string;
}

function need(ev: DecodedEvent, key: string): string {
  const v = ev.args[key];
  if (v === undefined) throw new ProjectionError(`${ev.name} at ${ev.blockNumber}:${ev.logIndex} is missing argument "${key}"`);
  return v;
}

function requireActive(current: EscrowRow | undefined, ev: DecodedEvent): EscrowRow {
  if (!current) {
    throw new ProjectionError(
      `${ev.name} for unknown escrow ${ev.escrowId} at block ${ev.blockNumber}; ` +
        `START_BLOCK is probably after the contract's deployment block`,
    );
  }
  if (current.status !== "Active") {
    throw new ProjectionError(`${ev.name} for escrow ${ev.escrowId} in status ${current.status} at block ${ev.blockNumber}`);
  }
  return current;
}

/**
 * Pure, deterministic state transition. Replaying the same ordered event list always yields the
 * same projection, which is what makes rollback-and-replay after a reorg safe.
 * Returns `undefined` for events that do not affect the escrow projection.
 */
export function applyEvent(current: EscrowRow | undefined, ev: DecodedEvent): EscrowRow | undefined {
  const block = Number(ev.blockNumber);
  switch (ev.name) {
    case "EscrowCreated": {
      if (current) throw new ProjectionError(`duplicate EscrowCreated for escrow ${ev.escrowId} at block ${ev.blockNumber}`);
      return {
        id: need(ev, "id"),
        payer: need(ev, "payer"),
        payee: need(ev, "payee"),
        arbiter: need(ev, "arbiter"),
        token: need(ev, "token"),
        amount: need(ev, "amount"),
        deadline: Number(need(ev, "deadline")),
        status: "Active",
        payeeAmount: "0",
        payerAmount: "0",
        createdBlock: block,
        updatedBlock: block,
        createdTx: ev.txHash,
        updatedTx: ev.txHash,
      };
    }
    case "EscrowReleased": {
      const e = requireActive(current, ev);
      return { ...e, status: "Released", payeeAmount: need(ev, "payeeAmount"), payerAmount: "0", updatedBlock: block, updatedTx: ev.txHash };
    }
    case "EscrowRefunded": {
      const e = requireActive(current, ev);
      return { ...e, status: "Refunded", payeeAmount: "0", payerAmount: need(ev, "payerAmount"), updatedBlock: block, updatedTx: ev.txHash };
    }
    case "EscrowResolved": {
      const e = requireActive(current, ev);
      return {
        ...e,
        status: "Resolved",
        payeeAmount: need(ev, "payeeAmount"),
        payerAmount: need(ev, "payerAmount"),
        updatedBlock: block,
        updatedTx: ev.txHash,
      };
    }
    default:
      return undefined; // Withdrawn, Paused, OwnershipTransferred, ... are recorded but not projected
  }
}

/** Rebuild one escrow from its full ordered event history. */
export function replay(events: DecodedEvent[]): EscrowRow | undefined {
  let state: EscrowRow | undefined;
  for (const ev of events) {
    const next = applyEvent(state, ev);
    if (next) state = next;
  }
  return state;
}
