// End-to-end chaos scenario. Starts (or attaches to) a Hardhat node, deploys the contracts,
// fronts the node with two degradable RPC proxies, starts the indexer against the proxies and
// then: indexes a baseline, forces a chain reorg via evm_snapshot/evm_revert, kills one
// provider, degrades the other, takes everything down and brings it back. After every phase
// the indexer's view is compared with on-chain truth. Exit code is non-zero on any mismatch.
//
//   npm run chaos            # spawns `hardhat node` itself
//   npm run chaos -- --attach  # use an already running node on :8545
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { escrowAbi, escrowBytecode, mockErc20Abi, mockErc20Bytecode, type EscrowDto, type ProviderHealthDto } from "@reorg-safe/shared";
import { startFlakyProxy, type FlakyProxy } from "./flaky-proxy.ts";

// ----------------------------------------------------------------------------- setup

const here = dirname(fileURLToPath(import.meta.url));
const INDEXER_DIR = resolve(here, "../../indexer");
const CONTRACTS_DIR = resolve(here, "../../contracts");

const NODE_URL = process.env.NODE_URL ?? "http://127.0.0.1:8545";
const PROXY_PORTS = [8601, 8602];
const INDEXER_PORT = 4100;
const API = `http://127.0.0.1:${INDEXER_PORT}`;
const CONFIRMATIONS = 4;
const ATTACH = process.argv.includes("--attach");

// Hardhat's default development accounts (public, never use with real funds).
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  payer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  payee: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  arbiter: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  payee2: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const satisfies Record<string, Hex>;

const STATUS_NAMES = ["None", "Active", "Released", "Refunded", "Resolved"] as const;

const c = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

interface Check {
  phase: string;
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
let currentPhase = "setup";

function phase(name: string) {
  currentPhase = name;
  console.log(`\n${c.bold(c.cyan(`▶ ${name}`))}`);
}
function check(name: string, ok: boolean, detail = "") {
  checks.push({ phase: currentPhase, name, ok, detail });
  console.log(`  ${ok ? c.green("✔") : c.red("✘")} ${name}${detail ? c.dim(`  ${detail}`) : ""}`);
}
function info(msg: string) {
  console.log(`  ${c.dim("·")} ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(label: string, fn: () => Promise<T | undefined | false>, timeoutMs = 30_000, every = 150): Promise<T> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false) return v as T;
    } catch (e) {
      lastErr = e;
    }
    await sleep(every);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr instanceof Error ? lastErr.message : lastErr}` : ""}`);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(NODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

function killTree(child: ChildProcess | null) {
  if (!child?.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

// ----------------------------------------------------------------------------- main

async function main() {
  console.log(c.bold("\nreorg-safe-escrow · chaos runner\n"));
  const children: ChildProcess[] = [];
  const proxies: FlakyProxy[] = [];
  const dbDir = mkdtempSync(join(tmpdir(), "reorg-safe-chaos-"));

  const cleanup = async () => {
    // Stop the indexer before the proxies so shutdown does not look like an outage in its logs.
    for (const ch of [...children].reverse()) killTree(ch);
    await sleep(1000);
    for (const p of proxies) await p.close().catch(() => undefined);
    rmSync(dbDir, { recursive: true, force: true });
  };
  process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));

  try {
    // ---- node
    phase("node");
    let nodeUp = await rpc<string>("eth_chainId").then(() => true, () => false);
    if (!nodeUp && !ATTACH) {
      info(`starting hardhat node at ${NODE_URL}`);
      const node = spawn("npx hardhat node", { cwd: CONTRACTS_DIR, shell: true, stdio: "ignore" });
      children.push(node);
      await waitFor("hardhat node", () => rpc<string>("eth_chainId"), 60_000, 500);
      nodeUp = true;
    }
    check("devnet reachable", nodeUp, NODE_URL);

    // cacheTime: 0 — viem caches eth_blockNumber for 4s by default, which would make "head" stale.
    const publicClient = createPublicClient({ chain: hardhat, transport: http(NODE_URL), cacheTime: 0 });
    const wallet = (key: Hex) => createWalletClient({ chain: hardhat, transport: http(NODE_URL), account: privateKeyToAccount(key) });
    const deployer = wallet(KEYS.deployer);
    const payer = wallet(KEYS.payer);
    const arbiter = wallet(KEYS.arbiter);
    const payeeAddr = privateKeyToAccount(KEYS.payee).address;
    const payee2Addr = privateKeyToAccount(KEYS.payee2).address;
    const arbiterAddr = arbiter.account!.address;

    // ---- contracts
    phase("deploy");
    const escrow = await deploy(publicClient, deployer, escrowAbi, escrowBytecode, [deployer.account!.address]);
    const token = await deploy(publicClient, deployer, mockErc20Abi, mockErc20Bytecode, ["Mock USD", "mUSD"]);
    const deployBlock = Number(await publicClient.getBlockNumber()) - 1;
    check("Escrow + MockERC20 deployed", true, `${escrow} / ${token}`);

    await send(publicClient, deployer, { address: token, abi: mockErc20Abi, functionName: "mint", args: [payer.account!.address, parseEther("1000000")] });
    await send(publicClient, payer, { address: token, abi: mockErc20Abi, functionName: "approve", args: [escrow, parseEther("1000000")] });

    // ---- proxies + indexer
    phase("infrastructure");
    for (const [i, port] of PROXY_PORTS.entries()) {
      proxies.push(await startFlakyProxy({ name: `rpc-${i + 1}`, port, upstream: NODE_URL }));
    }
    const [p1, p2] = proxies as [FlakyProxy, FlakyProxy];
    info(`proxies: ${p1.url}, ${p2.url} -> ${NODE_URL}`);

    const indexer = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: INDEXER_DIR,
      env: {
        ...process.env,
        RPC_URLS: `${p1.url},${p2.url}`,
        CONTRACT_ADDRESS: escrow,
        START_BLOCK: String(deployBlock),
        CONFIRMATIONS: String(CONFIRMATIONS),
        POLL_INTERVAL_MS: "200",
        REQUEST_TIMEOUT_MS: "2000",
        FAILURE_THRESHOLD: "2",
        QUORUM: "2",
        DB_PATH: join(dbDir, "indexer.sqlite"),
        PORT: String(INDEXER_PORT),
        LOG_LEVEL: process.env.INDEXER_LOG_LEVEL ?? "warn",
        LOG_FORMAT: "pretty",
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    children.push(indexer);
    await waitFor("indexer api", () => getJson<{ ok: boolean }>(`${API}/health`), 30_000, 250);
    check("indexer up", true, API);

    const head = async () => Number(await publicClient.getBlockNumber());
    const status = () => getJson<{ localTip: number | null; finalized: number | null; reorgCount: number; lastError: string | null; running: boolean }>(`${API}/status`);
    const waitSynced = async (label = "indexer synced") => {
      const target = await head();
      const s = await waitFor(label, async () => {
        const st = await status();
        return st.localTip === target ? st : undefined;
      });
      return s;
    };
    const providers = () => getJson<ProviderHealthDto[]>(`${API}/providers`);
    const indexed = (id: bigint) => getJson<EscrowDto>(`${API}/escrows/${id}`);
    const onChain = (id: bigint) => publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "getEscrow", args: [id] });

    const compare = async (id: bigint, label = `escrow #${id} matches chain`) => {
      const [a, b] = await Promise.all([indexed(id).catch(() => null), onChain(id).catch(() => null)]);
      if (!a || !b) return check(label, false, `indexer=${a ? "found" : "missing"} chain=${b ? "found" : "missing"}`);
      const same =
        a.payer.toLowerCase() === b.payer.toLowerCase() &&
        a.payee.toLowerCase() === b.payee.toLowerCase() &&
        a.arbiter.toLowerCase() === b.arbiter.toLowerCase() &&
        a.token.toLowerCase() === b.token.toLowerCase() &&
        a.amount === b.amount.toString() &&
        a.deadline === Number(b.deadline) &&
        a.status === STATUS_NAMES[b.status];
      check(label, same, `${a.status} / payee ${a.payee.slice(0, 8)}…`);
    };

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
    const createEth = (to: Address, eth: string) =>
      send(publicClient, payer, {
        address: escrow,
        abi: escrowAbi,
        functionName: "createEscrow",
        args: [to, arbiterAddr, zeroAddress, parseEther(eth), deadline],
        value: parseEther(eth),
      });
    const createToken = (to: Address, amount: string) =>
      send(publicClient, payer, { address: escrow, abi: escrowAbi, functionName: "createEscrow", args: [to, arbiterAddr, token, parseEther(amount), deadline] });
    const release = (id: bigint) => send(publicClient, payer, { address: escrow, abi: escrowAbi, functionName: "release", args: [id] });
    const resolveSplit = (id: bigint, payeeAmount: bigint) =>
      send(publicClient, arbiter, { address: escrow, abi: escrowAbi, functionName: "resolve", args: [id, payeeAmount] });
    const mine = (n: number) => rpc("hardhat_mine", [`0x${n.toString(16)}`]);

    // ---- phase 1: baseline
    phase("baseline indexing");
    await createEth(payeeAddr, "1");
    await createToken(payeeAddr, "250");
    await createEth(payeeAddr, "0.5");
    await release(1n);
    await mine(2);
    const s1 = await waitSynced();
    check("tip follows head", s1.localTip === (await head()), `tip=${s1.localTip}`);
    for (const id of [1n, 2n, 3n]) await compare(id);
    check("no reorgs yet", s1.reorgCount === 0);

    // ---- phase 2: reorg
    phase("forced reorg (evm_snapshot / evm_revert)");
    const snapshot = await rpc<string>("evm_snapshot");
    const forkPoint = await head();
    await createEth(payeeAddr, "2"); // #4 on the doomed branch
    await release(2n); //              #2 released on the doomed branch
    await waitSynced("doomed branch indexed");
    const doomed4 = await indexed(4n);
    const doomed2 = await indexed(2n);
    check("doomed branch indexed before revert", doomed4.payee.toLowerCase() === payeeAddr.toLowerCase() && doomed2.status === "Released");

    const reverted = await rpc<boolean>("evm_revert", [snapshot]);
    check("evm_revert accepted", reverted === true, `back to block ${forkPoint}`);
    // Canonical branch: same heights, different history, one block longer.
    await createEth(payee2Addr, "3"); //          #4 now goes to a different payee
    await resolveSplit(2n, parseEther("100")); // #2 is Resolved instead of Released
    await createToken(payee2Addr, "10"); //       #5 only exists here
    const s2 = await waitSynced("canonical branch indexed");
    check("reorg detected exactly once", s2.reorgCount === 1, `reorgCount=${s2.reorgCount}`);
    const reorgs = await getJson<Array<{ depth: number; commonAncestor: number; oldTip: number; newTip: number; eventsRolledBack: number }>>(`${API}/reorgs`);
    const r = reorgs[0];
    check("reorg metadata", !!r && r.commonAncestor === forkPoint && r.depth === 2 && r.eventsRolledBack === 2, r ? `ancestor=${r.commonAncestor} depth=${r.depth} rolledBack=${r.eventsRolledBack}` : "none");
    for (const id of [1n, 2n, 3n, 4n, 5n]) await compare(id);
    const e4 = await indexed(4n);
    check("orphaned branch state is gone", e4.payee.toLowerCase() === payee2Addr.toLowerCase() && (await indexed(2n)).status === "Resolved");
    check("indexer still healthy after reorg", s2.running && s2.lastError === null);

    // ---- phase 3: provider failover
    phase("provider failover (rpc-1 down)");
    p1.set({ down: true });
    await createEth(payeeAddr, "0.25"); // #6
    await mine(1);
    const s3 = await waitSynced("indexed through rpc-2 only");
    await compare(6n);
    // Head polling fans out to both providers every tick, so rpc-1 accumulates failures quickly.
    const ph3 = await waitFor("rpc-1 circuit open", async () => {
      const ph = await providers();
      return ph.find((p) => p.url === p1.url)!.state === "open" ? ph : undefined;
    }, 10_000, 200);
    const p1h = ph3.find((p) => p.url === p1.url)!;
    const p2h = ph3.find((p) => p.url === p2.url)!;
    check("rpc-1 circuit opened", p1h.state === "open", `state=${p1h.state} failures=${p1h.consecutiveFailures} lastError="${p1h.lastError}"`);
    check("rpc-2 healthy and ranked first", p2h.state === "closed" && ph3[0]!.url === p2.url);
    check("no false reorg during failover", s3.reorgCount === 1);

    p1.set({ down: false });
    const recovered = await waitFor("rpc-1 circuit closed", async () => {
      const ph = await providers();
      const h = ph.find((p) => p.url === p1.url)!;
      return h.state === "closed" ? h : undefined;
    }, 20_000, 250);
    check("rpc-1 recovered after half-open probe", recovered.state === "closed", `latency≈${recovered.ewmaLatencyMs}ms`);

    // ---- phase 4: latency-aware routing
    phase("latency-aware routing (rpc-1 slow)");
    p1.set({ latencyMs: 400 });
    await mine(3);
    await waitSynced();
    const ph4 = await waitFor("rpc-2 preferred", async () => {
      const ph = await providers();
      return ph[0]!.url === p2.url && ph.find((p) => p.url === p1.url)!.ewmaLatencyMs > ph[0]!.ewmaLatencyMs ? ph : undefined;
    }, 15_000, 250);
    check("slow provider demoted", true, `rpc-1 ${ph4.find((p) => p.url === p1.url)!.ewmaLatencyMs}ms vs rpc-2 ${ph4[0]!.ewmaLatencyMs}ms`);
    p1.set({ latencyMs: 0 });

    // ---- phase 5: total outage and recovery
    phase("total outage");
    p1.set({ down: true });
    p2.set({ down: true });
    await createEth(payeeAddr, "0.1"); // #7 happens while the indexer is blind
    const s5 = await waitFor("indexer reports outage", async () => {
      const st = await status();
      return st.lastError && st.running ? st : undefined;
    }, 15_000, 200);
    check("indexer survives with error surfaced", s5.running && /all providers failed/i.test(s5.lastError ?? ""), s5.lastError?.slice(0, 60) ?? "");
    p1.set({ down: false });
    p2.set({ down: false });
    await mine(1);
    const s5b = await waitSynced("caught up after outage");
    await compare(7n);
    check("error cleared after recovery", s5b.lastError === null);

    // ---- phase 6: finality bookkeeping
    phase("finality");
    await mine(CONFIRMATIONS + 1);
    const s6 = await waitSynced();
    check("finalized = tip - CONFIRMATIONS", s6.finalized === s6.localTip! - CONFIRMATIONS, `finalized=${s6.finalized} tip=${s6.localTip}`);
    const all = await getJson<EscrowDto[]>(`${API}/escrows`);
    check("all 7 escrows present", all.length === 7, all.map((e) => `#${e.id}:${e.status}${e.finalized ? "✓" : ""}`).join(" "));

    // ---- stats
    phase("summary");
    for (const p of proxies) info(`${p.name}: ${p.stats.requests} requests, ${p.stats.failed} failed, ${p.stats.forwarded} forwarded`);
  } catch (e) {
    check("scenario completed without exceptions", false, e instanceof Error ? e.message : String(e));
  } finally {
    await cleanup();
  }

  const failed = checks.filter((ch) => !ch.ok);
  console.log(`\n${c.bold(failed.length === 0 ? c.green(`all ${checks.length} checks passed`) : c.red(`${failed.length}/${checks.length} checks failed`))}`);
  for (const f of failed) console.log(`  ${c.red("✘")} [${f.phase}] ${f.name} ${c.dim(f.detail)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

// ----------------------------------------------------------------------------- helpers

async function deploy(publicClient: PublicClient, wallet: WalletClient, abi: any, bytecode: Hex, args: unknown[]): Promise<Address> {
  const hash = await wallet.deployContract({ abi, bytecode, args, account: wallet.account!, chain: hardhat });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("deployment produced no address");
  return receipt.contractAddress;
}

async function send(publicClient: PublicClient, wallet: WalletClient, req: any): Promise<void> {
  const hash = await wallet.writeContract({ ...req, account: wallet.account!, chain: hardhat });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx ${hash} reverted`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
