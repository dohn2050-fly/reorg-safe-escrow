import type { EscrowDto, IndexerStatusDto } from "@reorg-safe/shared";
import { formatAmount, relativeDeadline, short } from "../lib/format.ts";

function role(e: EscrowDto, account?: string): string | null {
  if (!account) return null;
  const a = account.toLowerCase();
  if (e.payer.toLowerCase() === a) return "payer";
  if (e.payee.toLowerCase() === a) return "payee";
  if (e.arbiter.toLowerCase() === a) return "arbiter";
  return null;
}

export function EscrowTable({
  escrows,
  selectedId,
  onSelect,
  account,
  status,
}: {
  escrows: EscrowDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  account?: string | undefined;
  status: IndexerStatusDto | null;
}) {
  if (escrows.length === 0) return <p className="muted empty">No escrows indexed yet. Create one on the right.</p>;
  const tip = status?.localTip ?? null;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>status</th>
            <th>amount</th>
            <th>payer → payee</th>
            <th>arbiter</th>
            <th>deadline</th>
            <th>confirmations</th>
            <th>you</th>
          </tr>
        </thead>
        <tbody>
          {escrows.map((e) => {
            const confs = tip === null ? null : tip - e.updatedBlock;
            const r = role(e, account);
            return (
              <tr key={e.id} className={e.id === selectedId ? "selected" : ""} onClick={() => onSelect(e.id)}>
                <td className="mono">{e.id}</td>
                <td>
                  <span className={`badge status-${e.status.toLowerCase()}`}>{e.status}</span>
                </td>
                <td className="mono">{formatAmount(e.amount, e.token)}</td>
                <td className="mono">
                  {short(e.payer)} → {short(e.payee)}
                </td>
                <td className="mono muted">{e.arbiter === "0x0000000000000000000000000000000000000000" ? "—" : short(e.arbiter)}</td>
                <td className="muted">{relativeDeadline(e.deadline)}</td>
                <td>
                  {e.finalized ? (
                    <span className="badge ok" title="deeper than the finality depth">
                      final
                    </span>
                  ) : (
                    <span className="badge" title={`updated in block ${e.updatedBlock}`}>
                      {confs === null ? "…" : `${confs} conf${confs === 1 ? "" : "s"}`}
                    </span>
                  )}
                </td>
                <td>{r ? <span className="badge role">{r}</span> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
