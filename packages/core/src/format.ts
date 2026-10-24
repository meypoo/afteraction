// Plain-text formatting helpers for terminal output.

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

export function fmtDuration(fromIso: string | null, toIso: string | null): string {
  if (!fromIso || !toIso) return "—";
  const s = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.round(h / 24)}d`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local date and time, e.g. 2026-01-15 10:00. */
export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local time of day, e.g. 10:00:39. */
export function fmtTime(iso: string | null): string {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}

/** Last path segment for either separator, so Windows paths display well everywhere. */
export function baseName(p: string | null): string {
  if (!p) return "—";
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? p;
}

/**
 * Make untrusted text safe to print to a terminal. Log content can carry escape sequences that
 * recolour or clear the screen, rewrite the window title, plant OSC 8 links or (on some terminals)
 * write the clipboard, and bidi overrides that make a command display differently from what ran.
 * Control characters become visible stand-ins (ESC → ␛); newlines and tabs are kept.
 */
export function safeTerminal(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, (c) => (c === "\u007f" ? "\u2421" : String.fromCharCode(0x2400 + c.charCodeAt(0))))
    .replace(/[\u0080-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "\ufffd");
}

/** safeTerminal on every string in a JSON-like value. */
export function safeTerminalDeep<T>(v: T): T {
  if (typeof v === "string") return safeTerminal(v) as T;
  if (Array.isArray(v)) return v.map(safeTerminalDeep) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, safeTerminalDeep(x)])) as T;
  }
  return v;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}
