import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { EscrowStatus, IndexerStatusDto, ProviderHealthDto, ReorgDto, StreamMessage } from "@reorg-safe/shared";
import type { IndexerDatabase } from "../db/Database.ts";
import type { Indexer } from "../indexer/Indexer.ts";
import type { Logger } from "../logger.ts";
import type { ProviderPool } from "../rpc/ProviderPool.ts";

export interface ServerDeps {
  indexer: Indexer;
  pool: ProviderPool;
  db: IndexerDatabase;
  logger: Logger;
}

const STATUSES: ReadonlySet<string> = new Set<EscrowStatus>(["Active", "Released", "Refunded", "Resolved"]);

export function buildServer({ indexer, pool, db, logger }: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(cors, { origin: true });

  app.get("/health", async () => {
    const s = indexer.status();
    return { ok: s.running && s.lastError === null, running: s.running, localTip: s.localTip, remoteHead: s.remoteHead, lag: s.lag };
  });

  app.get("/status", async () => indexer.status());

  app.get("/providers", async () => pool.snapshot());

  app.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>("/escrows", async (req, reply) => {
    const { status, limit, offset } = req.query;
    if (status !== undefined && !STATUSES.has(status)) {
      return reply.code(400).send({ error: `status must be one of ${[...STATUSES].join(", ")}` });
    }
    return db.listEscrows({
      ...(status !== undefined ? { status: status as EscrowStatus } : {}),
      limit: parseIntOr(limit, 100),
      offset: parseIntOr(offset, 0),
    });
  });

  app.get<{ Params: { id: string } }>("/escrows/:id", async (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) return reply.code(400).send({ error: "id must be a decimal integer" });
    const e = db.getEscrow(req.params.id);
    return e ?? reply.code(404).send({ error: "not found" });
  });

  app.get<{ Params: { id: string } }>("/escrows/:id/events", async (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) return reply.code(400).send({ error: "id must be a decimal integer" });
    return db.listEvents({ escrowId: req.params.id, limit: 1000 });
  });

  app.get<{ Querystring: { limit?: string } }>("/events", async (req) => db.listEvents({ limit: parseIntOr(req.query.limit, 100) }));

  app.get<{ Querystring: { limit?: string } }>("/reorgs", async (req) => db.listReorgs(parseIntOr(req.query.limit, 50)));

  /** Server-Sent Events: status, blocks, reorgs and provider-health changes as they happen. */
  app.get("/stream", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": req.headers.origin ?? "*",
    });
    res.write(": connected\n\n");

    const send = (msg: StreamMessage) => {
      res.write(`event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`);
    };

    send({ type: "status", status: indexer.status() });
    send({ type: "providers", providers: pool.snapshot() });

    const onStatus = (status: IndexerStatusDto) => send({ type: "status", status });
    const onBlocks = (b: { from: number; to: number; events: number }) => send({ type: "blocks", ...b });
    const onReorg = (reorg: ReorgDto) => send({ type: "reorg", reorg });
    const onProviders = (providers: ProviderHealthDto[]) => send({ type: "providers", providers });

    indexer.on("status", onStatus);
    indexer.on("blocks", onBlocks);
    indexer.on("reorg", onReorg);
    pool.on("change", onProviders);
    const heartbeat = setInterval(() => send({ type: "heartbeat", at: Date.now() }), 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      indexer.off("status", onStatus);
      indexer.off("blocks", onBlocks);
      indexer.off("reorg", onReorg);
      pool.off("change", onProviders);
      logger.debug("stream client disconnected");
    });
  });

  return app;
}

function parseIntOr(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
