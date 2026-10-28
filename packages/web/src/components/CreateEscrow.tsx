import { useState } from "react";
import { erc20Abi, isAddress, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { escrowAbi } from "@reorg-safe/shared";
import { errorText, short } from "../lib/format.ts";
import { ESCROW_ADDRESS } from "../wagmi.ts";

export function CreateEscrow() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [payee, setPayee] = useState("");
  const [arbiter, setArbiter] = useState("");
  const [token, setToken] = useState("");
  const [amount, setAmount] = useState("0.1");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const valid =
    isAddress(payee) && (arbiter === "" || isAddress(arbiter)) && (token === "" || isAddress(token)) && Number(amount) > 0 && Number(days) > 0;

  async function submit() {
    if (!address || !publicClient) return;
    setBusy(true);
    setMsg(null);
    try {
      const value = parseEther(amount);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(days) * 86400);
      const tokenAddr = (token || zeroAddress) as Address;

      if (tokenAddr !== zeroAddress) {
        const allowance = await publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: "allowance", args: [address, ESCROW_ADDRESS] });
        if (allowance < value) {
          setMsg({ kind: "ok", text: "approving token…" });
          const approveHash: Hex = await writeContractAsync({ address: tokenAddr, abi: erc20Abi, functionName: "approve", args: [ESCROW_ADDRESS, value] });
          await publicClient.waitForTransactionReceipt({ hash: approveHash });
        }
      }

      const hash = await writeContractAsync({
        address: ESCROW_ADDRESS,
        abi: escrowAbi,
        functionName: "createEscrow",
        args: [payee as Address, (arbiter || zeroAddress) as Address, tokenAddr, value, deadline],
        value: tokenAddr === zeroAddress ? value : 0n,
      });
      setMsg({ kind: "ok", text: `sent ${short(hash, 6)}, waiting…` });
      await publicClient.waitForTransactionReceipt({ hash });
      setMsg({ kind: "ok", text: `escrow created in ${short(hash, 6)}; it appears once the indexer commits the block.` });
    } catch (e) {
      setMsg({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>New escrow</h2>
        <span className="muted">ETH or any ERC-20</span>
      </div>
      <div className="form">
        <label className="field">
          <span>payee</span>
          <input className="input mono" value={payee} onChange={(e) => setPayee(e.target.value.trim())} placeholder="0x…" />
        </label>
        <label className="field">
          <span>arbiter (optional)</span>
          <input className="input mono" value={arbiter} onChange={(e) => setArbiter(e.target.value.trim())} placeholder="0x… or empty" />
        </label>
        <label className="field">
          <span>token (empty = ETH)</span>
          <input className="input mono" value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="0x… ERC-20" />
        </label>
        <div className="row">
          <label className="field">
            <span>amount (18 decimals)</span>
            <input className="input mono" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="field">
            <span>refundable after (days)</span>
            <input className="input mono" value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
        </div>
        <button className="btn primary" disabled={!address || !valid || busy} onClick={submit}>
          {address ? "create escrow" : "connect a wallet first"}
        </button>
        {msg ? <p className={`notice ${msg.kind}`}>{msg.text}</p> : null}
      </div>
    </div>
  );
}
