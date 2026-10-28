import { isAddress, getAddress, type Address } from "viem";
import { z } from "zod";

const csv = z.string().transform((s) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);

export const configSchema = z.object({
  /** Comma-separated JSON-RPC endpoints. Order is irrelevant: routing is health/latency based. */
  RPC_URLS: csv.pipe(z.array(z.url()).min(1, "at least one RPC URL is required")),
  CONTRACT_ADDRESS: z
    .string()
    .refine(isAddress, "CONTRACT_ADDRESS must be a 20-byte hex address")
    .transform((a): Address => getAddress(a)),
  /** First block to index (deployment block). */
  START_BLOCK: z.coerce.number().int().min(0).default(0),
  /** Blocks behind head considered final. Reorgs deeper than this are treated as a fatal integrity failure. */
  CONFIRMATIONS: z.coerce.number().int().min(1).default(12),
  /** Max blocks fetched per tick. */
  BLOCK_BATCH: z.coerce.number().int().min(1).max(1000).default(50),
  POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).default(8000),
  /** Providers consulted when deciding head height and canonical block hashes. */
  QUORUM: z.coerce.number().int().min(1).default(2),
  /** Blocks a provider may trail the best head before being flagged as lagging. */
  LAG_TOLERANCE: z.coerce.number().int().min(0).default(2),
  /** Consecutive failures before a provider's circuit opens. */
  FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(3),
  DB_PATH: z.string().default("./data/indexer.sqlite"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_FORMAT: z.enum(["pretty", "json"]).default("pretty"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid indexer configuration:\n${issues}`);
  }
  return result.data;
}
