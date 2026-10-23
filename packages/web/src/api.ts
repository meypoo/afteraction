// Typed fetch helpers for the local flightrec API.
import type { CostSummary, FileTouch, NormalizedEvent, RiskRow, SessionRow } from "@flightrec/core";

export type { CostSummary, FileTouch, NormalizedEvent, RiskRow, SessionRow };

export interface Meta {
  version: string;
  cost_label: string;
  prices: { last_updated: string; confirmed: boolean; source: string };
  sources: { source: string; sessions: number; events: number }[];
  rules: { id: string; severity: string; description: string }[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      // not JSON
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};

const enc = encodeURIComponent;

export const api = {
  meta: () => get<Meta>("/api/meta"),
  sessions: (f: Record<string, string | undefined>) => get<{ sessions: SessionRow[] }>(`/api/sessions${qs(f)}`),
  projects: () => get<{ projects: { project_path: string; sessions: number }[] }>("/api/projects"),
  session: (id: string) => get<{ session: SessionRow; files: FileTouch[] }>(`/api/sessions/${enc(id)}`),
  events: (id: string) => get<{ events: NormalizedEvent[] }>(`/api/sessions/${enc(id)}/events`),
  event: (id: string, opts: { reveal?: boolean; raw?: boolean }) =>
    get<{ event: NormalizedEvent }>(`/api/events/${enc(id)}${qs({ reveal: opts.reveal ? "1" : undefined, raw: opts.raw ? "1" : undefined })}`),
  receipt: async (id: string) => {
    const res = await fetch(`/api/sessions/${enc(id)}/receipt`);
    if (!res.ok) throw new Error(`${res.status}`);
    return res.text();
  },
  risks: (f: Record<string, string | undefined>) => get<{ risks: RiskRow[] }>(`/api/risks${qs(f)}`),
  costs: (since?: string) => get<CostSummary & { cost_label: string }>(`/api/costs${qs({ since })}`),
};
