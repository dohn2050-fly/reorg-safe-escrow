import { useState } from "react";
import { zeroAddress, type Address, type Hex } from "viem";
import { useAccount, useChainId, usePublicClient, useReadContract, useSignTypedData, useWriteContract } from "wagmi";
import { buildReleaseTypedData, escrowAbi, type EscrowDto } from "@reorg-safe/shared";
import { useEscrowEvents } from "../lib/indexer.ts";
import { errorText, formatAmount, formatTime, short } from "../lib/format.ts";
import { ESCROW_ADDRESS } from "../wagmi.ts";

interface SignedRelease {
  escrowId: string;
  nonce: string;
  deadline: string;
  signature: Hex;
  signer: Address;
  chainId: number;
  verifyingContract: Address;
}

export function EscrowActions({ escrow, onClose }: { escrow: EscrowDto; onClose: () => void }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const events = useEscrowEvents(escrow.id);

  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [signed, setSigned] = useState<SignedRelease | null>(null);
  const [relayInput, setRelayInput] = useState("");
  const [splitPayee, setSplitPayee] = useState("");

  const me = address?.toLowerCase();
  const isPayer = me === escrow.payer.toLowerCase();
  const isPayee = me === escrow.payee.toLowerCase();
  const isArbiter = me === escrow.arbiter.toLowerCase() && escrow.arbiter !== zeroAddress;
  const active = escrow.status === "Active";
  const pastDeadline = Date.now() / 1000 >= escrow.deadline;
  const id = BigInt(escrow.id);

  const { data: nonce } = useReadContract({
    address: ESCROW_ADDRESS,
    abi: escrowAbi,
    functionName: "nonces",
    args: [escrow.payer as Address],
    query: { refetchInterval: 5000 },
  });
  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: ESCROW_ADDRESS,
    abi: escrowAbi,
    functionName: "balances",
    args: [address ?? zeroAddress, escrow.token as Address],
    query: { enabled: !!address, refetchInterval: 5000 },
  });

  async function run(label: string, fn: () => Promise<Hex>) {
    setBusy(label);
    setMsg(null);
    try {
      const hash = await fn();
      setMsg({ kind: "ok", text: `${label}: tx ${short(hash, 6)} sent, waiting…` });
      await publicClient?.waitForTransactionReceipt({ hash });
      setMsg({ kind: "ok", text: `${label}: confirmed in ${short(hash, 6)} — the indexer will pick it up on its next tick.` });
      void refetchBalance();
    } catch (e) {
      setMsg({ kind: "err", text: `${label} failed: ${errorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  const write = (functionName: "release" | "refund" | "resolve" | "withdraw" | "releaseWithSig", args: readonly unknown[]) =>
    writeContractAsync({ address: ESCROW_ADDRESS, abi: escrowAbi, functionName, args } as never);

  async function signRelease() {
    if (nonce === undefined || !address) return;
    setBusy("sign");
    setMsg(null);
    try {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const typed = buildReleaseTypedData(chainId, ESCROW_ADDRESS, { escrowId: id, nonce, deadline });
      const signature = await signTypedDataAsync(typed);
      const payload: SignedRelease = {
        escrowId: escrow.id,
        nonce: nonce.toString(),
        deadline: deadline.toString(),
        signature,
        signer: address,
        chainId,
        verifyingContract: ESCROW_ADDRESS,
      };
      setSigned(payload);
      setRelayInput(JSON.stringify(payload, null, 2));
      setMsg({ kind: "ok", text: "Signed. Hand this payload to anyone — they pay the gas, you don't." });
    } catch (e) {
      setMsg({ kind: "err", text: `signing failed: ${errorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function relay() {
    let payload: SignedRelease;
    try {
      payload = JSON.parse(relayInput) as SignedRelease;
    } catch {
      setMsg({ kind: "err", text: "relay payload is not valid JSON" });
      return;
    }
    await run("relay signed release", () => write("releaseWithSig", [BigInt(payload.escrowId), BigInt(payload.deadline), payload.signature]));
  }

  return (
    <div className="card actions">
      <div className="card-head">
        <h2>
          Escrow #{escrow.id} <span className={`badge status-${escrow.status.toLowerCase()}`}>{escrow.status}</span>
        </h2>
        <button className="btn ghost" onClick={onClose}>
          close
        </button>
      </div>

      <dl className="kv">
        <dt>amount</dt>
        <dd className="mono">{formatAmount(escrow.amount, escrow.token)}</dd>
        <dt>payer</dt>
        <dd className="mono">{escrow.payer}</dd>
        <dt>payee</dt>
        <dd className="mono">{escrow.payee}</dd>
        <dt>arbiter</dt>
        <dd className="mono">{escrow.arbiter === zeroAddress ? "none" : escrow.arbiter}</dd>
        <dt>deadline</dt>
        <dd>{formatTime(escrow.deadline)}</dd>
        <dt>created / updated</dt>
        <dd className="mono">
          block {escrow.createdBlock} ({short(escrow.createdTx, 6)}) / block {escrow.updatedBlock} ({short(escrow.updatedTx, 6)})
        </dd>
        {escrow.status !== "Active" ? (
          <>
            <dt>settlement</dt>
            <dd className="mono">
              payee {formatAmount(escrow.payeeAmount, escrow.token)} · payer {formatAmount(escrow.payerAmount, escrow.token)}
            </dd>
          </>
        ) : null}
      </dl>

      {!address ? <p className="muted">Connect a wallet to act on this escrow.</p> : null}

      {address && active ? (
        <div className="action-grid">
          {isPayer ? (
            <div className="action">
              <h3>Release (pay gas yourself)</h3>
              <button className="btn primary" disabled={!!busy} onClick={() => run("release", () => write("release", [id]))}>
                release to payee
              </button>
            </div>
          ) : null}

          {isPayer ? (
            <div className="action">
              <h3>Gasless release (EIP-712)</h3>
              <p className="muted">
                Sign <code>Release(escrowId, nonce={nonce?.toString() ?? "…"}, deadline)</code> off-chain. Any relayer can submit it;
                the contract verifies the signature against your address (EOA or ERC-1271).
              </p>
              <button className="btn" disabled={!!busy || nonce === undefined} onClick={signRelease}>
                sign release authorisation
              </button>
              {signed ? <textarea className="payload" readOnly value={JSON.stringify(signed, null, 2)} rows={6} /> : null}
            </div>
          ) : null}

          {(isPayer || isPayee) ? (
            <div className="action">
              <h3>Refund</h3>
              <p className="muted">{pastDeadline ? "Deadline passed: funds can be returned to the payer." : `Available after ${formatTime(escrow.deadline)}.`}</p>
              <button className="btn" disabled={!!busy || !pastDeadline} onClick={() => run("refund", () => write("refund", [id]))}>
                refund to payer
              </button>
            </div>
          ) : null}

          {isArbiter ? (
            <div className="action">
              <h3>Resolve (arbiter)</h3>
              <label className="field">
                <span>amount to payee (wei, rest returns to payer)</span>
                <input className="input mono" value={splitPayee} onChange={(e) => setSplitPayee(e.target.value)} placeholder={escrow.amount} />
              </label>
              <button
                className="btn"
                disabled={!!busy || !/^\d+$/.test(splitPayee)}
                onClick={() => run("resolve", () => write("resolve", [id, BigInt(splitPayee)]))}
              >
                resolve
              </button>
            </div>
          ) : null}

          <div className="action">
            <h3>Relay a signed release (anyone)</h3>
            <textarea className="payload" rows={5} value={relayInput} onChange={(e) => setRelayInput(e.target.value)} placeholder='{"escrowId":"1","deadline":"…","signature":"0x…"}' />
            <button className="btn" disabled={!!busy || !relayInput.trim()} onClick={relay}>
              submit releaseWithSig
            </button>
          </div>
        </div>
      ) : null}

      {address && balance !== undefined && balance > 0n ? (
        <div className="action withdraw">
          <h3>Your withdrawable balance</h3>
          <p className="mono">{formatAmount(balance, escrow.token)}</p>
          <button className="btn primary" disabled={!!busy} onClick={() => run("withdraw", () => write("withdraw", [escrow.token as Address]))}>
            withdraw
          </button>
        </div>
      ) : null}

      {msg ? <p className={`notice ${msg.kind}`}>{msg.text}</p> : null}

      <details className="history">
        <summary>Event history ({events.data?.length ?? 0})</summary>
        <ul>
          {(events.data ?? []).map((ev) => (
            <li key={ev.id} className="mono">
              <span className="muted">#{ev.blockNumber}</span> {ev.name} {ev.finalized ? <span className="badge ok">final</span> : null}
              <span className="muted"> {short(ev.txHash, 6)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
