import { useReorgs } from "../lib/indexer.ts";
import { short } from "../lib/format.ts";

export function ReorgLog() {
  const reorgs = useReorgs();
  if (!reorgs.data || reorgs.data.length === 0) {
    return (
      <p className="muted">
        No reorgs observed. On the local devnet, run <code>npm run chaos</code> to force one.
      </p>
    );
  }
  return (
    <ul className="reorgs">
      {reorgs.data.map((r) => (
        <li key={r.id}>
          <div className="reorg-row">
            <span className="badge warn">depth {r.depth}</span>
            <span className="mono">
              {r.oldTip} → {r.commonAncestor} → {r.newTip}
            </span>
          </div>
          <div className="muted">
            {new Date(r.detectedAt).toLocaleTimeString()} · {r.eventsRolledBack} event{r.eventsRolledBack === 1 ? "" : "s"} rolled back · orphaned tip{" "}
            <span className="mono">{short(r.oldTipHash, 6)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
