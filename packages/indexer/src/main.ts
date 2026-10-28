import { buildServer } from "./api/server.ts";
import { ChainTracker } from "./chain/ChainTracker.ts";
import { PoolChainSource } from "./chain/PoolChainSource.ts";
import { loadConfig } from "./config.ts";
import { IndexerDatabase } from "./db/Database.ts";
import { Indexer } from "./indexer/Indexer.ts";
import { createLogger } from "./logger.ts";
import { ProviderPool } from "./rpc/ProviderPool.ts";
import { createViemRpcClient } from "./rpc/viemClient.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, format: config.LOG_FORMAT });

  const clients = config.RPC_URLS.map((url) => createViemRpcClient(url, { timeoutMs: config.REQUEST_TIMEOUT_MS }));
  const pool = new ProviderPool(clients, {
    quorum: config.QUORUM,
    lagTolerance: BigInt(config.LAG_TOLERANCE),
    failureThreshold: config.FAILURE_THRESHOLD,
  });
  pool.on("circuit-open", (e) => logger.warn("provider circuit opened", e));
  pool.on("circuit-closed", (e) => logger.info("provider circuit closed", e));
  pool.on("lagging", (e) => logger.warn("provider lagging", e));

  // Refuse to start if the providers disagree on which chain they serve.
  const chainIds = await pool.fanout("eth_chainId", (c) => c.getChainId(), pool.size);
  const distinct = new Set(chainIds.map((r) => r.value));
  if (distinct.size !== 1) {
    throw new Error(`providers disagree on chainId: ${chainIds.map((r) => `${r.url}=${r.value}`).join(", ")}`);
  }
  const chainId = chainIds[0]!.value;

  const db = new IndexerDatabase(config.DB_PATH);
  const storedContract = db.getMeta("contract");
  const storedChain = db.getMeta("chainId");
  if ((storedContract && storedContract !== config.CONTRACT_ADDRESS) || (storedChain && storedChain !== String(chainId))) {
    throw new Error(
      `database ${config.DB_PATH} was built for ${storedContract} on chain ${storedChain}; ` +
        `refusing to mix with ${config.CONTRACT_ADDRESS} on chain ${chainId}. Use a different DB_PATH.`,
    );
  }
  db.setMeta("contract", config.CONTRACT_ADDRESS);
  db.setMeta("chainId", String(chainId));

  const source = new PoolChainSource(pool);
  const tracker = new ChainTracker(source, { startBlock: BigInt(config.START_BLOCK), batchSize: config.BLOCK_BATCH });
  const indexer = new Indexer({
    source,
    tracker,
    db,
    logger: logger.child({ component: "indexer" }),
    config: {
      contract: config.CONTRACT_ADDRESS,
      chainId,
      startBlock: BigInt(config.START_BLOCK),
      confirmations: BigInt(config.CONFIRMATIONS),
      pollIntervalMs: config.POLL_INTERVAL_MS,
    },
  });

  const server = buildServer({ indexer, pool, db, logger: logger.child({ component: "api" }) });
  await server.listen({ host: config.HOST, port: config.PORT });
  logger.info("api listening", { url: `http://${config.HOST}:${config.PORT}` });

  indexer.on("fatal", () => {
    logger.error("indexer halted on integrity failure; API stays up for inspection");
  });
  indexer.start();

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    await indexer.stop();
    await server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
