import type { IndexerStatusDto } from "@reorg-safe/shared";
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { short } from "../lib/format.ts";
import type { config } from "../wagmi.ts";

type SupportedChainId = (typeof config)["chains"][number]["id"];

export function Header({ connected, status }: { connected: boolean; status: IndexerStatusDto | null }) {
  const { address, isConnected, chainId: walletChain } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  const wrongChain = isConnected && status !== null && walletChain !== status.chainId;

  return (
    <header className="header">
      <div className="brand">
        <span className="logo">⛓</span>
        <div>
          <h1>Reorg-Safe Escrow</h1>
          <p className="muted">EIP-712 gasless release · reorg-aware indexer · multi-RPC failover</p>
        </div>
      </div>

      <div className="header-right">
        <span className={`pill ${connected ? "ok" : "bad"}`} title="Indexer SSE stream">
          <span className="dot" /> indexer {connected ? "live" : "offline"}
        </span>
        <span className="pill" title="Chain id used by the app">
          chain {status?.chainId ?? chainId}
        </span>

        {isConnected ? (
          <>
            {wrongChain ? (
              <button className="btn warn" onClick={() => switchChain({ chainId: status!.chainId as SupportedChainId })}>
                switch to chain {status!.chainId}
              </button>
            ) : null}
            <button className="btn" onClick={() => disconnect()} title={address}>
              {short(address ?? "", 5)} · disconnect
            </button>
          </>
        ) : (
          connectors.map((c) => (
            <button key={c.uid} className="btn primary" disabled={isPending} onClick={() => connect({ connector: c })}>
              connect {c.name}
            </button>
          ))
        )}
      </div>
    </header>
  );
}
