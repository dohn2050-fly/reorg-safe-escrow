import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import type { EscrowDto, EscrowStatus, EventDto, ReorgDto } from "@reorg-safe/shared";
import type { DecodedEvent } from "../indexer/decode.ts";
import { applyEvent, replay, type EscrowRow } from "../indexer/reducer.ts";
import type { BlockHeader } from "../rpc/types.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS blocks (
  number       INTEGER PRIMARY KEY,
  hash         TEXT    NOT NULL UNIQUE,
  parent_hash  TEXT    NOT NULL,
  timestamp    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  block_number INTEGER NOT NULL,
  block_hash   TEXT    NOT NULL,
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  escrow_id    TEXT,
  args         TEXT    NOT NULL,
  finalized    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (block_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_events_block  ON events (block_number);
CREATE INDEX IF NOT EXISTS idx_events_escrow ON events (escrow_id, block_number, log_index);

CREATE TABLE IF NOT EXISTS escrows (
  id            TEXT PRIMARY KEY,
  payer         TEXT    NOT NULL,
  payee         TEXT    NOT NULL,
  arbiter       TEXT    NOT NULL,
  token         TEXT    NOT NULL,
  amount        TEXT    NOT NULL,
  deadline      INTEGER NOT NULL,
  status        TEXT    NOT NULL,
  payee_amount  TEXT    NOT NULL,
  payer_amount  TEXT    NOT NULL,
  created_block INTEGER NOT NULL,
  updated_block INTEGER NOT NULL,
  created_tx    TEXT    NOT NULL,
  updated_tx    TEXT    NOT NULL,
  finalized     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_escrows_status ON escrows (status);

CREATE TABLE IF NOT EXISTS reorgs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at        INTEGER NOT NULL,
  common_ancestor    INTEGER NOT NULL,
  old_tip            INTEGER NOT NULL,
  old_tip_hash       TEXT    NOT NULL,
  new_tip            INTEGER NOT NULL,
  depth              INTEGER NOT NULL,
  events_rolled_back INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface BlockRow {
  number: number;
  hash: string;
  parent_hash: string;
  timestamp: number;
}

interface EventRow {
  id: number;
  block_number: number;
  block_hash: string;
  tx_hash: string;
  log_index: number;
  name: string;
  escrow_id: string | null;
  args: string;
  finalized: number;
}

interface EscrowDbRow {
  id: string;
  payer: string;
  payee: string;
  arbiter: string;
  token: string;
  amount: string;
  deadline: number;
  status: string;
  payee_amount: string;
  payer_amount: string;
  created_block: number;
  updated_block: number;
  created_tx: string;
  updated_tx: string;
  finalized: number;
}

interface ReorgRow {
  id: number;
  detected_at: number;
  common_ancestor: number;
  old_tip: number;
  old_tip_hash: string;
  new_tip: number;
  depth: number;
  events_rolled_back: number;
}

export interface ReorgRecord {
  detectedAt: number;
  commonAncestor: bigint;
  oldTip: BlockHeader;
  newTip: bigint;
  depth: number;
}

export interface RollbackResult {
  eventsRemoved: number;
  blocksRemoved: number;
  affectedEscrows: string[];
}

/**
 * SQLite persistence (Node's built-in `node:sqlite`, no native build step).
 *
 * Invariants:
 *  - `blocks` is a contiguous, parent-linked window ending at the local tip. Blocks below the
 *    finalized height are pruned; the finalized block itself is kept as the reorg floor.
 *  - `events` is the source of truth. `escrows` is a projection derived purely from `events`
 *    and can always be rebuilt by replay.
 *  - Every block range is committed in one transaction together with its events and projection
 *    updates, so a crash can never leave headers without their events (or vice versa).
 */
export class IndexerDatabase {
  private readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------ transactions

  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }

  // ------------------------------------------------------------ meta

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ------------------------------------------------------------ blocks

  getTip(): BlockHeader | null {
    const row = this.db.prepare("SELECT * FROM blocks ORDER BY number DESC LIMIT 1").get() as BlockRow | undefined;
    return row ? toHeader(row) : null;
  }

  getBlock(number: bigint): BlockHeader | null {
    const row = this.db.prepare("SELECT * FROM blocks WHERE number = ?").get(Number(number)) as BlockRow | undefined;
    return row ? toHeader(row) : null;
  }

  getFinalized(): bigint | null {
    const v = this.getMeta("finalized");
    return v === null ? null : BigInt(v);
  }

  blockCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM blocks").get() as { c: number }).c;
  }

  // ------------------------------------------------------------ writes

  /** Append a contiguous block range with its events and apply them to the projection. */
  commitExtend(blocks: BlockHeader[], events: DecodedEvent[]): void {
    this.transaction(() => {
      this.insertBlocks(blocks);
      this.insertEvents(events);
      this.project(events);
    });
  }

  /**
   * Roll back to `commonAncestor`, append the replacement range, record the reorg. One transaction:
   * readers never observe the orphaned state and the new state at the same time.
   */
  commitReorg(reorg: ReorgRecord, blocks: BlockHeader[], events: DecodedEvent[]): RollbackResult {
    return this.transaction(() => {
      const result = this.rollbackTo(reorg.commonAncestor);
      this.insertBlocks(blocks);
      this.insertEvents(events);
      this.project(events);
      this.db
        .prepare(
          `INSERT INTO reorgs (detected_at, common_ancestor, old_tip, old_tip_hash, new_tip, depth, events_rolled_back)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reorg.detectedAt,
          Number(reorg.commonAncestor),
          Number(reorg.oldTip.number),
          reorg.oldTip.hash,
          Number(reorg.newTip),
          reorg.depth,
          result.eventsRemoved,
        );
      return result;
    });
  }

  /** Delete everything above `ancestor` and rebuild the projection of every affected escrow. */
  rollbackTo(ancestor: bigint): RollbackResult {
    return this.transaction(() => {
      const a = Number(ancestor);
      const affected = (
        this.db
          .prepare("SELECT DISTINCT escrow_id FROM events WHERE block_number > ? AND escrow_id IS NOT NULL")
          .all(a) as Array<{ escrow_id: string }>
      ).map((r) => r.escrow_id);

      const eventsRemoved = Number(this.db.prepare("DELETE FROM events WHERE block_number > ?").run(a).changes);
      const blocksRemoved = Number(this.db.prepare("DELETE FROM blocks WHERE number > ?").run(a).changes);

      const del = this.db.prepare("DELETE FROM escrows WHERE id = ?");
      for (const id of affected) {
        del.run(id);
        const history = this.eventsForEscrow(id);
        const rebuilt = replay(history);
        if (rebuilt) this.upsertEscrow(rebuilt);
      }
      return { eventsRemoved, blocksRemoved, affectedEscrows: affected };
    });
  }

  /** Mark everything at or below `upTo` final and prune headers below it. */
  finalize(upTo: bigint): void {
    const n = Number(upTo);
    this.transaction(() => {
      this.db.prepare("UPDATE events SET finalized = 1 WHERE finalized = 0 AND block_number <= ?").run(n);
      this.db.prepare("UPDATE escrows SET finalized = 1 WHERE finalized = 0 AND updated_block <= ?").run(n);
      this.db.prepare("DELETE FROM blocks WHERE number < ?").run(n);
      this.setMeta("finalized", String(n));
    });
  }

  private insertBlocks(blocks: BlockHeader[]): void {
    const stmt = this.db.prepare("INSERT INTO blocks (number, hash, parent_hash, timestamp) VALUES (?, ?, ?, ?)");
    for (const b of blocks) stmt.run(Number(b.number), b.hash, b.parentHash, Number(b.timestamp));
  }

  private insertEvents(events: DecodedEvent[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO events (block_number, block_hash, tx_hash, log_index, name, escrow_id, args)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of events) {
      stmt.run(Number(e.blockNumber), e.blockHash, e.txHash, e.logIndex, e.name, e.escrowId, JSON.stringify(e.args));
    }
  }

  private project(events: DecodedEvent[]): void {
    for (const ev of events) {
      if (ev.escrowId === null) continue;
      const current = this.getEscrowRow(ev.escrowId);
      const next = applyEvent(current, ev);
      if (next) this.upsertEscrow(next);
    }
  }

  private upsertEscrow(e: EscrowRow): void {
    this.db
      .prepare(
        `INSERT INTO escrows (id, payer, payee, arbiter, token, amount, deadline, status, payee_amount, payer_amount,
                              created_block, updated_block, created_tx, updated_tx, finalized)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status, payee_amount = excluded.payee_amount, payer_amount = excluded.payer_amount,
           updated_block = excluded.updated_block, updated_tx = excluded.updated_tx, finalized = 0`,
      )
      .run(
        e.id,
        e.payer,
        e.payee,
        e.arbiter,
        e.token,
        e.amount,
        e.deadline,
        e.status,
        e.payeeAmount,
        e.payerAmount,
        e.createdBlock,
        e.updatedBlock,
        e.createdTx,
        e.updatedTx,
      );
  }

  // ------------------------------------------------------------ reads

  private getEscrowRow(id: string): EscrowRow | undefined {
    const row = this.db.prepare("SELECT * FROM escrows WHERE id = ?").get(id) as EscrowDbRow | undefined;
    return row ? toEscrowRow(row) : undefined;
  }

  private eventsForEscrow(id: string): DecodedEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE escrow_id = ? ORDER BY block_number, log_index")
      .all(id) as unknown as EventRow[];
    return rows.map(toDecoded);
  }

  getEscrow(id: string): EscrowDto | null {
    const row = this.db.prepare("SELECT * FROM escrows WHERE id = ?").get(id) as EscrowDbRow | undefined;
    return row ? toEscrowDto(row) : null;
  }

  listEscrows(opts: { status?: EscrowStatus; limit?: number; offset?: number } = {}): EscrowDto[] {
    const limit = Math.min(opts.limit ?? 100, 1000);
    const offset = opts.offset ?? 0;
    const rows = (
      opts.status
        ? this.db
            .prepare("SELECT * FROM escrows WHERE status = ? ORDER BY length(id) DESC, id DESC LIMIT ? OFFSET ?")
            .all(opts.status, limit, offset)
        : this.db.prepare("SELECT * FROM escrows ORDER BY length(id) DESC, id DESC LIMIT ? OFFSET ?").all(limit, offset)
    ) as unknown as EscrowDbRow[];
    return rows.map(toEscrowDto);
  }

  listEvents(opts: { escrowId?: string; limit?: number } = {}): EventDto[] {
    const limit = Math.min(opts.limit ?? 100, 1000);
    const rows = (
      opts.escrowId !== undefined
        ? this.db
            .prepare("SELECT * FROM events WHERE escrow_id = ? ORDER BY block_number DESC, log_index DESC LIMIT ?")
            .all(opts.escrowId, limit)
        : this.db.prepare("SELECT * FROM events ORDER BY block_number DESC, log_index DESC LIMIT ?").all(limit)
    ) as unknown as EventRow[];
    return rows.map(toEventDto);
  }

  listReorgs(limit = 50): ReorgDto[] {
    const rows = this.db.prepare("SELECT * FROM reorgs ORDER BY id DESC LIMIT ?").all(limit) as unknown as ReorgRow[];
    return rows.map((r) => ({
      id: r.id,
      detectedAt: r.detected_at,
      commonAncestor: r.common_ancestor,
      oldTip: r.old_tip,
      oldTipHash: r.old_tip_hash,
      newTip: r.new_tip,
      depth: r.depth,
      eventsRolledBack: r.events_rolled_back,
    }));
  }

  counts(): { events: number; escrows: number; reorgs: number } {
    const c = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      events: c("SELECT COUNT(*) AS c FROM events"),
      escrows: c("SELECT COUNT(*) AS c FROM escrows"),
      reorgs: c("SELECT COUNT(*) AS c FROM reorgs"),
    };
  }
}

// ---------------------------------------------------------------- mappers

function toHeader(r: BlockRow): BlockHeader {
  return { number: BigInt(r.number), hash: r.hash as Hex, parentHash: r.parent_hash as Hex, timestamp: BigInt(r.timestamp) };
}

function toDecoded(r: EventRow): DecodedEvent {
  return {
    blockNumber: BigInt(r.block_number),
    blockHash: r.block_hash as Hex,
    txHash: r.tx_hash as Hex,
    logIndex: r.log_index,
    name: r.name,
    escrowId: r.escrow_id,
    args: JSON.parse(r.args) as Record<string, string>,
  };
}

function toEventDto(r: EventRow): EventDto {
  return {
    id: r.id,
    blockNumber: r.block_number,
    blockHash: r.block_hash,
    txHash: r.tx_hash,
    logIndex: r.log_index,
    name: r.name,
    escrowId: r.escrow_id,
    args: JSON.parse(r.args) as Record<string, string>,
    finalized: r.finalized === 1,
  };
}

function toEscrowRow(r: EscrowDbRow): EscrowRow {
  return {
    id: r.id,
    payer: r.payer,
    payee: r.payee,
    arbiter: r.arbiter,
    token: r.token,
    amount: r.amount,
    deadline: r.deadline,
    status: r.status as EscrowStatus,
    payeeAmount: r.payee_amount,
    payerAmount: r.payer_amount,
    createdBlock: r.created_block,
    updatedBlock: r.updated_block,
    createdTx: r.created_tx,
    updatedTx: r.updated_tx,
  };
}

function toEscrowDto(r: EscrowDbRow): EscrowDto {
  return { ...toEscrowRow(r), finalized: r.finalized === 1 };
}
