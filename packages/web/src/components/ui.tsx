import type { ReactNode } from "react";

export type Risk = "none" | "low" | "medium" | "high" | "critical";

const RISK_STYLE: Record<Risk, string> = {
  none: "text-muted border-line",
  low: "text-sky-600 border-sky-500/40 bg-sky-500/10 dark:text-sky-300",
  medium: "text-amber-700 border-amber-500/40 bg-amber-500/10 dark:text-amber-300",
  high: "text-red-700 border-red-500/40 bg-red-500/10 dark:text-red-300",
  critical: "text-white border-red-600 bg-red-600",
};

export function RiskBadge({ level, title }: { level: string; title?: string }) {
  const l = (level in RISK_STYLE ? level : "none") as Risk;
  return (
    <span title={title} className={`inline-block rounded border px-1.5 py-px text-[11px] font-medium leading-4 ${RISK_STYLE[l]}`}>
      {l}
    </span>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-md border border-line bg-panel ${className}`}>{children}</div>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="truncate text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

export function Button({ children, onClick, active, title, disabled }: {
  children: ReactNode; onClick?: () => void; active?: boolean; title?: string; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded border px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
        active ? "border-accent bg-accent/15 text-accent" : "border-line bg-raised hover:border-muted"
      }`}
    >
      {children}
    </button>
  );
}

export const inputClass = "rounded border border-line bg-panel px-2 py-1 text-xs outline-none focus:border-accent";

export function Loading() {
  return <div className="p-6 text-muted">Loading…</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="m-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-red-600 dark:text-red-300">{String(error instanceof Error ? error.message : error)}</div>;
}

/** Small note required wherever a cost is shown. */
export function CostLabel() {
  return <span className="text-[11px] text-muted">estimated, API-equivalent</span>;
}
