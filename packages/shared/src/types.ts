// DTOs exchanged between the indexer API and its consumers (web app, chaos runner).
// All on-chain integers are serialised as decimal strings; block numbers as JS numbers.

export type EscrowStatus = "Active" | "Released" | "Refunded" | "Resolved";

export interface EscrowDto {
  id: string;
  payer: string;
  payee: string;
  arbiter: string;
  token: string;
  amount: string;
  deadline: number;
  status: EscrowStatus;
  /** Amount credited to payee at settlement (0 while Active). */
  payeeAmount: string;
  /** Amount credited back to payer at settlement (0 while Active). */
  payerAmount: string;
  createdBlock: number;
  updatedBlock: number;
  createdTx: string;
  updatedTx: string;
  /** True once every event for this escrow is deeper than the finality depth. */
  finalized: boolean;
}

export interface EventDto {
  id: number;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
  name: string;
  escrowId: string | null;
  args: Record<string, string>;
  finalized: boolean;
}

export interface ReorgDto {
  id: number;
  detectedAt: number;
  commonAncestor: number;
  oldTip: number;
  oldTipHash: string;
  newTip: number;
  depth: number;
  eventsRolledBack: number;
}

export type CircuitState = "closed" | "open" | "half-open";

export interface ProviderHealthDto {
  url: string;
  state: CircuitState;
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
  ewmaLatencyMs: number;
  lastHead: number | null;
  lagging: boolean;
  lastError: string | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  openUntil: number | null;
}

export interface IndexerStatusDto {
  chainId: number;
  contract: string;
  startBlock: number;
  confirmations: number;
  localTip: number | null;
  localTipHash: string | null;
  finalized: number | null;
  remoteHead: number | null;
  lag: number | null;
  reorgCount: number;
  eventCount: number;
  escrowCount: number;
  lastTickAt: number | null;
  lastError: string | null;
  running: boolean;
  startedAt: number;
}

export type StreamMessage =
  | { type: "status"; status: IndexerStatusDto }
  | { type: "blocks"; from: number; to: number; events: number }
  | { type: "reorg"; reorg: ReorgDto }
  | { type: "providers"; providers: ProviderHealthDto[] }
  | { type: "heartbeat"; at: number };
