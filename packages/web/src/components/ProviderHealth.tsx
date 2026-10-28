import type { ProviderHealthDto } from "@reorg-safe/shared";

export function ProviderHealth({ providers }: { providers: ProviderHealthDto[] }) {
  if (providers.length === 0) return <p className="muted">No provider data yet.</p>;
  return (
    <ul className="providers">
      {providers.map((p, i) => (
        <li key={p.url} className={`provider ${p.state} ${p.lagging ? "lagging" : ""}`}>
          <div className="provider-row">
            <span className="rank">#{i + 1}</span>
            <code className="url" title={p.url}>
              {p.url.replace(/^https?:\/\//, "")}
            </code>
            <span className={`badge ${p.state}`}>{p.state}</span>
            {p.lagging ? <span className="badge warn">lagging</span> : null}
          </div>
          <div className="provider-meta muted">
            <span>{p.ewmaLatencyMs} ms</span>
            <span>head {p.lastHead ?? "—"}</span>
            <span>
              {p.totalFailures}/{p.totalCalls} failed
            </span>
            {p.consecutiveFailures ? <span className="err">{p.consecutiveFailures} consecutive</span> : null}
          </div>
          {p.lastError && p.state !== "closed" ? <div className="provider-err">{p.lastError}</div> : null}
        </li>
      ))}
    </ul>
  );
}
