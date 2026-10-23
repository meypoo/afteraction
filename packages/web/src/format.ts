// Display helpers (the browser build cannot import the Node-side core package at runtime).

export function fmtTokens(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(v);
}

export function fmtCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return "$" + usd.toFixed(2);
}

export function fmtDuration(from: string | null, to: string | null): string {
  if (!from || !to) return "—";
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.round(h / 24)}d`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function baseName(p: string | null | undefined): string {
  if (!p) return "—";
  return p.split(/[\\/]+/).filter(Boolean).pop() ?? p;
}

/** Path relative to the project when inside it. */
export function relPath(p: string, project: string | null): string {
  if (!project) return p;
  const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = norm(p);
  const b = norm(project);
  const win = /^[a-zA-Z]:/.test(b);
  if (win ? a.toLowerCase().startsWith(b.toLowerCase() + "/") : a.startsWith(b + "/")) return a.slice(b.length + 1);
  return p;
}

// Keep in sync with AGENT_LABELS in packages/core/src/model.ts.
export const AGENT_LABEL: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode: "OpenCode",
};

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
