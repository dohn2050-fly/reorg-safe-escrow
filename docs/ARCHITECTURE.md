# Architecture

This document explains how the indexer stays correct under reorgs and provider faults, and how the pieces fit. For the "why" at a glance see the [README](../README.md).

## Components

```
                      ┌──────────────────────────── indexer process ────────────────────────────┐
 rpc-1 ──┐            │  ProviderPool ──► PoolChainSource ──► ChainTracker ──► Indexer ──► DB    │
 rpc-2 ──┼─ JSON-RPC ─┤        ▲                                   │               │        │     │
 rpc-n ──┘            │  circuit breakers                    SyncPlan        verified   SQLite   │
                      │  latency EWMA                        idle|extend|reorg  events  (atomic) │
                      │  head quorum / hash votes                                   │            │
                      │                                                   Fastify REST + SSE     │
                      └──────────────────────────────────────────────────────────────────────────┘
```

| Module | Responsibility | Pure? |
|---|---|---|
| `rpc/ProviderPool` | Route calls to the healthiest provider, fail over, open/close circuits, quorum for head and block hashes, attribute results to URLs. | stateful, no I/O of its own |
| `rpc/viemClient` | Adapt viem to the 5-method `RpcClient` interface. viem retries and caching are disabled. | I/O |
| `chain/ChainTracker` | Given the local header window and the network, produce a `SyncPlan`. Never mutates. | pure w.r.t. storage |
| `indexer/decode`, `indexer/reducer` | Decode Escrow logs; deterministic escrow state machine. | pure |
| `db/Database` | `node:sqlite` store; atomic `commitExtend` / `commitReorg`; rollback-and-replay; finalize/prune; read models. | I/O |
| `indexer/Indexer` | The loop: plan → fetch & verify events → commit → finalize → emit. Error policy. | orchestration |
| `api/server` | REST read models + SSE stream (`status`, `blocks`, `reorg`, `providers`). | I/O |

Dependencies point inwards: `Indexer` depends on interfaces (`ChainSource`, `LogSource`, `LocalChainView`) so the whole pipeline runs in tests against an in-memory fake chain.

## The sync loop

Each tick:

1. `head = pool.getHead()` — fan out `eth_blockNumber` to `QUORUM` providers, take the max, flag providers more than `LAG_TOLERANCE` behind as *lagging* (they are demoted but not disabled).
2. `plan = tracker.plan({ tip, finalized, getBlock })`:

   | Situation | Action |
   |---|---|
   | no local tip | fetch `[START_BLOCK, START_BLOCK + batch)` → **extend** |
   | `head <= tip` | ask quorum for hash at `tip.number`; equal → **idle** (providers just haven't advanced); different / absent → **reorg**; no consensus → **idle** |
   | `head > tip` and next block's `parentHash == tip.hash` | **extend** with the longest internally-linked prefix of the fetched range |
   | `head > tip` and parent mismatch | ask quorum for hash at `tip.number`; equal → the fetched block came from a forked provider → penalise it, **idle**; different → **reorg** |

   **reorg**: walk `n = tip-1, tip-2, …` asking the quorum for the canonical hash until it equals our stored hash → `commonAncestor`. The walk stops at the finalized block: if even that differs, throw `FinalityViolationError`. Then fetch `[ancestor+1, …]` and verify it attaches to the ancestor.

3. `events = fetchVerifiedEvents(plan.blocks, head)`:
   - blocks with `number <= head - CONFIRMATIONS`: one `eth_getLogs(fromBlock, toBlock)`; every log's `blockHash` must equal the tracked header's hash, otherwise the provider is penalised and another one is tried (3 attempts);
   - blocks above that: `eth_getLogs({ blockHash })` per block. A provider on another fork cannot answer for a hash it does not have, so it errors and the pool fails over. This closes the "silently omitted event" hole that hash comparison alone leaves open.
4. Commit:
   - **extend**: `BEGIN; insert blocks; insert events; apply events to escrows; COMMIT`
   - **reorg**: `BEGIN; delete events/blocks > ancestor; rebuild each affected escrow by replaying its remaining events; insert new blocks/events; apply; insert reorg row; COMMIT`
5. `finalize(head - CONFIRMATIONS)`: mark events/escrows final, prune headers below the finalized block (the finalized header itself is kept as the reorg floor), persist `meta.finalized`.
6. Emit `blocks` / `reorg` / `status` to SSE subscribers.

Error policy in the loop: `FinalityViolationError` and `ProjectionError` are **fatal** (loop stops, `status.lastError` set, API stays up). Everything else (`AllProvidersFailedError`, `InconsistentProviderDataError`, network errors) is logged, surfaced in `/status`, and retried with exponential back-off capped at 30 s.

## Provider pool details

- **Score** = `ewmaLatency × (1 + consecutiveFailures)` `+ 10 000` if half-open `+ 100 000` if lagging `+ 1 000 000` if open. Lowest first. Open circuits are only used when nothing else is available (forced probe).
- **Circuit**: `closed → open` after `FAILURE_THRESHOLD` consecutive failures (or any failure while half-open); open duration `openBaseMs × 2^reopenCount` capped at `openMaxMs`; `open → half-open` when the window elapses; `half-open → closed` on the first success.
- **Attribution**: `call()` returns `{ value, url }`; `penalize(url, reason)` counts as a failure. Inconsistent-but-valid responses therefore degrade a provider exactly like transport errors do.
- **Votes**: `canonicalHash(n)` collects `{url, hash|null}` from the quorum; `null` means "no block at that height" and is a legitimate vote (the chain shrank). Consensus requires `count × 2 > votes`. With two providers that disagree there is no consensus and the tracker waits.

## Storage schema

```sql
blocks  (number PK, hash UNIQUE, parent_hash, timestamp)                 -- header window, contiguous
events  (id, block_number, block_hash, tx_hash, log_index, name,
         escrow_id, args JSON, finalized, UNIQUE(block_hash, log_index)) -- source of truth
escrows (id PK, payer, payee, arbiter, token, amount, deadline, status,
         payee_amount, payer_amount, created_block, updated_block,
         created_tx, updated_tx, finalized)                              -- projection (derived)
reorgs  (id, detected_at, common_ancestor, old_tip, old_tip_hash, new_tip, depth, events_rolled_back)
meta    (key PK, value)                                                   -- finalized, contract, chainId
```

Invariants:
- `blocks` is parent-linked and ends at the tip; nothing below `meta.finalized` except the finalized block itself.
- `escrows` is a pure function of `events` ordered by `(block_number, log_index)`. `rollbackTo` proves this by rebuilding affected rows from scratch.
- Every write path is one transaction; a crash between ticks can never leave headers without their events.
- `meta.contract` / `meta.chainId` are checked at start-up: a database cannot be accidentally reused for a different deployment.

## Escrow state machine (reducer)

```
            EscrowCreated
   (none) ───────────────► Active ──EscrowReleased──► Released
                              │
                              ├──EscrowRefunded──► Refunded
                              └──EscrowResolved──► Resolved
```
Any other transition throws `ProjectionError`. `Withdrawn`, `Paused`, `Unpaused`, `OwnershipTransferred` are stored as events but do not touch the projection.

## API

| Route | Returns |
|---|---|
| `GET /health` | `{ ok, running, localTip, remoteHead, lag }` |
| `GET /status` | `IndexerStatusDto` |
| `GET /providers` | `ProviderHealthDto[]`, best first |
| `GET /escrows?status=&limit=&offset=` | `EscrowDto[]` |
| `GET /escrows/:id`, `GET /escrows/:id/events` | one escrow / its ordered events |
| `GET /events?limit=`, `GET /reorgs?limit=` | recent events / reorgs |
| `GET /stream` | SSE: `status`, `blocks`, `reorg`, `providers`, `heartbeat` |

DTO types live in `@reorg-safe/shared` and are consumed by the web app and the chaos runner unchanged.

## Chaos runner

`packages/chaos/src/run.ts` is both a demo and an integration test:

1. starts `hardhat node` (or attaches with `--attach`), deploys `Escrow` and `MockERC20`;
2. starts two `flaky-proxy` instances in front of the node and the indexer against them (`CONFIRMATIONS=4`, `QUORUM=2`);
3. **baseline** — ETH and ERC-20 escrows, a release, empty blocks; indexer state == `getEscrow()` for every id;
4. **reorg** — `evm_snapshot`; two blocks of activity; indexer confirms; `evm_revert`; three *different* blocks; asserts exactly one reorg of depth 2 with 2 events rolled back, and that every escrow equals on-chain truth (including the one whose payee changed between branches);
5. **failover** — rpc-1 down: circuit opens, rpc-2 serves, no false reorg; rpc-1 back: half-open probe closes the circuit;
6. **latency** — rpc-1 +400 ms: ranking flips;
7. **total outage** — both down: `status.lastError` set while the process keeps running; back up: catches up and clears the error;
8. **finality** — `finalized == tip − CONFIRMATIONS`, all escrows present and marked final.

The proxies expose `GET/POST /__chaos` so the same faults can be injected by hand while watching the dashboard.
