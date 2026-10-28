import type { IndexerStatusDto, ReorgDto } from "@reorg-safe/shared";
import { short } from "../lib/format.ts";

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string | undefined;
  tone?: "ok" | "warn" | "bad" | undefined;
}) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

export function StatusBar({ status, lastReorg }: { status: IndexerStatusDto | null; lastReorg: ReorgDto | null }) {
  if (!status) {
    return (
      <div className="stats">
        <Stat label="indexer" value="connecting…" tone="warn" />
      </div>
    );
  }
  const lagTone = status.lag === null ? "warn" : status.lag <= 1 ? "ok" : status.lag < 10 ? "warn" : "bad";
  return (
    <div className="stats">
      <Stat label="local tip" value={status.localTip ?? "—"} sub={status.localTipHash ? short(status.localTipHash, 6) : undefined} />
      <Stat label="remote head" value={status.remoteHead ?? "—"} sub={`lag ${status.lag ?? "—"}`} tone={lagTone} />
      <Stat label="finalized" value={status.finalized ?? "—"} sub={`${status.confirmations} confirmations`} />
      <Stat label="reorgs handled" value={status.reorgCount} sub={lastReorg ? `last: depth ${lastReorg.depth} @${lastReorg.commonAncestor}` : "none yet"} tone={status.reorgCount ? "warn" : undefined} />
      <Stat label="events / escrows" value={`${status.eventCount} / ${status.escrowCount}`} sub={status.running ? "running" : "halted"} tone={status.running ? (status.lastError ? "warn" : "ok") : "bad"} />
      {status.lastError ? (
        <div className="stat bad wide">
          <span className="stat-label">last error</span>
          <span className="stat-sub">{status.lastError}</span>
        </div>
      ) : null}
    </div>
  );
}
