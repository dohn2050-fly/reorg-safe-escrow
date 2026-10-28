import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { CreateEscrow } from "./components/CreateEscrow.tsx";
import { EscrowActions } from "./components/EscrowActions.tsx";
import { EscrowTable } from "./components/EscrowTable.tsx";
import { Header } from "./components/Header.tsx";
import { ProviderHealth } from "./components/ProviderHealth.tsx";
import { ReorgLog } from "./components/ReorgLog.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { useEscrows, useIndexerStream, useProvidersFallback } from "./lib/indexer.ts";

export function App() {
  const live = useIndexerStream();
  const providers = useProvidersFallback(live.providers);
  const escrows = useEscrows();
  const { address } = useAccount();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(() => escrows.data?.find((e) => e.id === selectedId) ?? null, [escrows.data, selectedId]);

  return (
    <div className="app">
      <Header connected={live.connected} status={live.status} />

      <main className="grid">
        <section className="col-main">
          <StatusBar status={live.status} lastReorg={live.lastReorg} />

          <div className="card">
            <div className="card-head">
              <h2>Escrows</h2>
              <span className="muted">
                {escrows.data?.length ?? 0} indexed · click a row to act on it
                {escrows.isError ? <span className="err"> · indexer unreachable</span> : null}
              </span>
            </div>
            <EscrowTable
              escrows={escrows.data ?? []}
              selectedId={selectedId}
              onSelect={setSelectedId}
              account={address}
              status={live.status}
            />
          </div>

          {selected ? <EscrowActions escrow={selected} onClose={() => setSelectedId(null)} /> : null}
        </section>

        <aside className="col-side">
          <CreateEscrow />
          <div className="card">
            <div className="card-head">
              <h2>RPC providers</h2>
              <span className="muted">health-ranked, failover + hash quorum</span>
            </div>
            <ProviderHealth providers={providers} />
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Reorg log</h2>
              <span className="muted">rolled back &amp; replayed</span>
            </div>
            <ReorgLog />
          </div>
        </aside>
      </main>
    </div>
  );
}
