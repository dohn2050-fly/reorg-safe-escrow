// A JSON-RPC reverse proxy whose behaviour can be degraded at runtime: hard down, random
// failures, added latency. Two of these in front of one devnet are enough to exercise every
// failover path in the indexer's ProviderPool.
//
// Control endpoint:  GET  /__chaos                      -> { mode, stats }
//                    POST /__chaos {"down":true,...}    -> update mode
//                    GET  /__chaos?down=1&failRate=0.3&latencyMs=250
import http from "node:http";
import { fileURLToPath } from "node:url";

export interface ChaosMode {
  down: boolean;
  /** 0..1 probability that a request fails with a JSON-RPC error. */
  failRate: number;
  latencyMs: number;
}

export interface ProxyStats {
  requests: number;
  failed: number;
  forwarded: number;
  byMethod: Record<string, number>;
}

export interface FlakyProxy {
  name: string;
  url: string;
  mode: ChaosMode;
  stats: ProxyStats;
  set(partial: Partial<ChaosMode>): void;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rpcError(id: unknown, message: string) {
  // -32603 (internal error) so clients report the message verbatim instead of "invalid params".
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message } });
}

export function startFlakyProxy(opts: { name: string; port: number; upstream: string; host?: string }): Promise<FlakyProxy> {
  const host = opts.host ?? "127.0.0.1";
  const mode: ChaosMode = { down: false, failRate: 0, latencyMs: 0 };
  const stats: ProxyStats = { requests: 0, failed: 0, forwarded: 0, byMethod: {} };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${opts.port}`);

    if (url.pathname === "/__chaos") {
      if (req.method === "POST") {
        const body = await readBody(req);
        Object.assign(mode, sanitise(JSON.parse(body || "{}")));
      } else {
        const q = Object.fromEntries(url.searchParams);
        if (Object.keys(q).length) Object.assign(mode, sanitise(q));
      }
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ name: opts.name, mode, stats }));
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const body = await readBody(req);
    let id: unknown = null;
    try {
      const parsed = JSON.parse(body) as { id?: unknown; method?: string } | Array<{ method?: string }>;
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of calls) {
        const m = c.method ?? "?";
        stats.byMethod[m] = (stats.byMethod[m] ?? 0) + 1;
      }
      if (!Array.isArray(parsed)) id = parsed.id ?? null;
    } catch {
      /* not JSON; forward anyway */
    }
    stats.requests++;

    if (mode.down) {
      stats.failed++;
      res.writeHead(503, { "content-type": "application/json", ...corsHeaders() });
      res.end(rpcError(id, `chaos(${opts.name}): provider down`));
      return;
    }
    if (mode.failRate > 0 && Math.random() < mode.failRate) {
      stats.failed++;
      res.writeHead(500, { "content-type": "application/json", ...corsHeaders() });
      res.end(rpcError(id, `chaos(${opts.name}): injected failure`));
      return;
    }
    if (mode.latencyMs > 0) await sleep(mode.latencyMs);

    try {
      const upstream = await fetch(opts.upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const text = await upstream.text();
      stats.forwarded++;
      res.writeHead(upstream.status, { "content-type": "application/json", ...corsHeaders() });
      res.end(text);
    } catch (e) {
      stats.failed++;
      res.writeHead(502, { "content-type": "application/json", ...corsHeaders() });
      res.end(rpcError(id, `chaos(${opts.name}): upstream unreachable: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      resolve({
        name: opts.name,
        url: `http://${host}:${opts.port}`,
        mode,
        stats,
        set: (partial) => Object.assign(mode, partial),
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, GET, OPTIONS",
  };
}

function sanitise(input: Record<string, unknown>): Partial<ChaosMode> {
  const out: Partial<ChaosMode> = {};
  if ("down" in input) out.down = input.down === true || input.down === "1" || input.down === "true";
  if ("failRate" in input) out.failRate = Math.min(1, Math.max(0, Number(input.failRate) || 0));
  if ("latencyMs" in input) out.latencyMs = Math.max(0, Number(input.latencyMs) || 0);
  return out;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Standalone mode: `npm run proxy` starts two proxies in front of a local node for manual demos.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const upstream = process.env.UPSTREAM ?? "http://127.0.0.1:8545";
  const ports = (process.env.PROXY_PORTS ?? "8601,8602").split(",").map((p) => Number(p.trim()));
  for (const [i, port] of ports.entries()) {
    const p = await startFlakyProxy({ name: `rpc-${i + 1}`, port, upstream });
    console.log(`${p.name}: ${p.url} -> ${upstream}   (control: ${p.url}/__chaos)`);
  }
}
