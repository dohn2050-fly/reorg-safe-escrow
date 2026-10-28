import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { EscrowDto, EventDto, IndexerStatusDto, ProviderHealthDto, ReorgDto, StreamMessage } from "@reorg-safe/shared";
import { INDEXER_URL } from "../wagmi.ts";

export async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${INDEXER_URL}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface LiveState {
  connected: boolean;
  status: IndexerStatusDto | null;
  providers: ProviderHealthDto[];
  /** Incremented whenever the indexer commits blocks or handles a reorg. */
  version: number;
  lastReorg: ReorgDto | null;
}

/** Subscribes to the indexer's SSE stream and invalidates list queries when the chain view changes. */
export function useIndexerStream(): LiveState {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>({ connected: false, status: null, providers: [], version: 0, lastReorg: null });
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;

    const connect = () => {
      es = new EventSource(`${INDEXER_URL}/stream`);
      es.onopen = () => setState((s) => ({ ...s, connected: true }));
      es.onerror = () => {
        setState((s) => ({ ...s, connected: false }));
        es?.close();
        if (!closed) reconnectTimer.current = setTimeout(connect, 2000);
      };
      const handle = (e: MessageEvent<string>) => {
        const msg = JSON.parse(e.data) as StreamMessage;
        switch (msg.type) {
          case "status":
            setState((s) => ({ ...s, status: msg.status }));
            break;
          case "providers":
            setState((s) => ({ ...s, providers: msg.providers }));
            break;
          case "blocks":
            setState((s) => ({ ...s, version: s.version + 1 }));
            void qc.invalidateQueries({ queryKey: ["escrows"] });
            void qc.invalidateQueries({ queryKey: ["events"] });
            break;
          case "reorg":
            setState((s) => ({ ...s, version: s.version + 1, lastReorg: msg.reorg }));
            void qc.invalidateQueries({ queryKey: ["escrows"] });
            void qc.invalidateQueries({ queryKey: ["events"] });
            void qc.invalidateQueries({ queryKey: ["reorgs"] });
            break;
          default:
            break;
        }
      };
      for (const type of ["status", "providers", "blocks", "reorg"]) es.addEventListener(type, handle as EventListener);
    };
    connect();

    return () => {
      closed = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      es?.close();
    };
  }, [qc]);

  return state;
}

export function useEscrows() {
  return useQuery({ queryKey: ["escrows"], queryFn: () => api<EscrowDto[]>("/escrows?limit=200"), refetchInterval: 10_000 });
}

export function useEscrowEvents(id: string | null) {
  return useQuery({
    queryKey: ["events", id],
    queryFn: () => api<EventDto[]>(`/escrows/${id}/events`),
    enabled: id !== null,
  });
}

export function useReorgs() {
  return useQuery({ queryKey: ["reorgs"], queryFn: () => api<ReorgDto[]>("/reorgs"), refetchInterval: 15_000 });
}

export function useProvidersFallback(live: ProviderHealthDto[]) {
  const q = useQuery({ queryKey: ["providers"], queryFn: () => api<ProviderHealthDto[]>("/providers"), refetchInterval: 5_000, enabled: live.length === 0 });
  return live.length > 0 ? live : (q.data ?? []);
}
