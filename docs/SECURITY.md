# Security notes

## Smart contract: `Escrow.sol`

### Threat model
Parties: payer, payee, optional arbiter, owner (pauser), relayers (anyone submitting `releaseWithSig`), arbitrary ERC-20 tokens.

| Threat | Mitigation | Test |
|---|---|---|
| Reentrancy during withdrawal | Pull-payment ledger; `withdraw` is `nonReentrant` and zeroes the balance **before** the external call (CEI). No other function performs an outbound transfer. | `test_Withdraw_ReentrancyIsBlocked` |
| Reentrancy via ERC-20 hooks on deposit | `createEscrow` is `nonReentrant`; state is written after the token pull. | — (guarded by modifier) |
| Signature replay (same escrow) | Status check: an escrow can only leave `Active` once. | `test_ReleaseWithSig_RejectsReplay` |
| Signature reuse on another escrow | `escrowId` is part of the signed struct; sequential per-payer `nonce` is consumed on use. | `test_ReleaseWithSig_RejectsReplay`, `test_ReleaseWithSig_RejectsStaleNonce` |
| Cross-chain / cross-deployment replay | EIP-712 domain binds `chainId` and `verifyingContract`. | `test_ReleaseWithSig_DifferentDeploymentCannotReplay` |
| Stale authorisation | Signed `deadline`, checked against `block.timestamp`. | `test_ReleaseWithSig_RejectsExpired` |
| Signature malleability / wrong signer | OpenZeppelin `SignatureChecker` → `ECDSA.tryRecover` (rejects high-s) or ERC-1271. | `test_ReleaseWithSig_RejectsWrongSigner`, `test_ReleaseWithSig_ERC1271Wallet` |
| Owner traps funds via pause | Only entry paths are pausable. `refund` and `withdraw` are always available. | `test_Pause_BlocksEntryButNotExit` |
| Owner key mistakes | `Ownable2Step` requires the new owner to accept. | — |
| Fee-on-transfer / rebasing tokens over-credit payee | Deposit records `balanceAfter − balanceBefore`. | `test_CreateERC20_FeeOnTransfer_RecordsReceivedAmount` |
| Arbiter steals funds | Arbiter can only split the escrowed amount between payer and payee (`payeeAmount ≤ amount`). | `test_Resolve_RevertsWhenSplitExceedsAmount`, `testFuzz_ResolveConservesValue` |
| Griefing refund before deadline | `refund` requires `block.timestamp ≥ deadline` and caller ∈ {payer, payee}. | `test_Refund_RevertsBeforeDeadline`, `test_Refund_RevertsForStranger`, `testFuzz_RefundOnlyAfterDeadline` |
| Receiver rejects ETH | `withdraw` reverts with `NativeTransferFailed`; ledger is untouched so a smart-contract payee can retry or upgrade. | `test_Withdraw_RevertsIfReceiverRejectsEther` |
| Self-escrow / zero payee / zero amount / past deadline | Explicit custom-error checks. | `test_Create_RevertsOnBadInputs` |

### Known limitations / conscious scope cuts
- **Sequential nonces** mean a payer with several escrows must have signed releases executed in nonce order; a signature for nonce *k* is invalidated once nonce *k* is consumed by any escrow. Unordered nonces (bitmaps, as in Permit2) are a straightforward extension and were left out to keep the demo focused.
- **No fee / treasury**, no partial releases, no dispute window. The state machine is intentionally minimal so the indexer's correctness is easy to verify.
- **Arbiter is trusted** for the escrows that name one; use `address(0)` to disable arbitration.
- ERC-777-style tokens with receive hooks are tolerated (guarded) but untested; tokens that revert on zero-value transfers are fine because zero amounts are rejected up front.
- Not audited. Deployment to a public network for this demo would use Sepolia only.

## Indexer integrity guarantees

The indexer is designed so that the only way to serve wrong data is to be told the same lie by a strict majority of configured providers at the same time.

| Guarantee | Mechanism |
|---|---|
| Events are attributed to the exact block the indexer tracks | Deep blocks: `log.blockHash` must equal the tracked header; recent blocks: fetched **by blockHash** (EIP-234), so a provider without that block cannot answer. |
| A single lagging/forked provider cannot cause a false reorg | Parent mismatch → quorum vote on our tip; the lone dissenter is penalised, not followed. |
| A single forked provider cannot hide a real reorg | Head is the quorum **max**; a stale provider's lower head only ever produces `idle`. |
| No partial state is ever observable | Headers + events + projection changes commit in one SQLite transaction; reorg rollback and replacement are the same transaction. |
| Finalized data is immutable | Reorg search floors at the finalized block; a divergence below it halts the indexer with `FinalityViolationError` instead of rewriting history. |
| The projection cannot drift | `escrows` is a pure function of `events`; after a reorg affected rows are rebuilt by replay, not patched. Impossible transitions throw. |
| A database is never mixed across deployments | `meta.contract` / `meta.chainId` are verified at start-up. |

Operational notes:
- `CONFIRMATIONS` is the only safety knob that matters. On a PoS L1 use ≥ 64 (two epochs) or pin to the `finalized` tag; on L2s follow the sequencer's reorg guidance; on devnets 2–6 keeps demos snappy.
- Run with **≥ 3 providers from different operators** so that `QUORUM=2` votes have a tie-breaker and a single operator incident cannot stall decisions.
- The API is read-only and unauthenticated; it exposes no secrets. Put it behind your usual ingress if exposed publicly.

## Web app
- Never holds keys; all signing happens in the connected wallet via EIP-1193 / EIP-6963 (injected) or WalletConnect.
- The gasless-release payload shown to the user is exactly what gets submitted: `escrowId`, `nonce`, `deadline`, `signature`, plus `chainId` and `verifyingContract` for transparency. The typed data is built by the same shared helper the tests use, so wallets display the real `Release` struct.
- Contract address and RPC are build-time configuration (`VITE_*`); the UI warns and offers a chain switch when the wallet is on a different chain than the indexer.
