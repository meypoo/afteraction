import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes } from "react";
import { Icon } from "./icons";

export type Risk = "none" | "low" | "medium" | "high" | "critical";

const RISK_STYLE: Record<Risk, string> = {
  none: "text-muted bg-transparent ring-1 ring-inset ring-line",
  low: "text-risk-low bg-risk-low-soft",
  medium: "text-risk-medium bg-risk-medium-soft",
  high: "text-risk-high bg-risk-high-soft",
  critical: "text-white bg-risk-critical",
};

const RISK_DOT: Record<Risk, string> = {
  none: "bg-line-strong",
  low: "bg-risk-low",
  medium: "bg-risk-medium",
  high: "bg-risk-high",
  critical: "bg-risk-critical",
};

export const asRisk = (level: string): Risk => (level in RISK_STYLE ? (level as Risk) : "none");

/** Severity chip: square-cornered, tinted, with a leading dot. */
export function RiskBadge({ level, title, compact }: { level: string; title?: string; compact?: boolean }) {
  const l = asRisk(level);
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-chip px-1.5 text-2xs font-medium leading-5 ${RISK_STYLE[l]}`}
    >
      {l !== "critical" && <span className={`size-1.5 rounded-full ${RISK_DOT[l]}`} />}
      {!compact && l}
    </span>
  );
}

export function RiskDot({ level, className = "" }: { level: string; className?: string }) {
  return <span className={`inline-block size-2 rounded-full ${RISK_DOT[asRisk(level)]} ${className}`} />;
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`overflow-hidden rounded-panel border border-line bg-surface shadow-panel ${className}`}>{children}</section>;
}

export function PanelHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
      <h2 className="text-xs font-medium text-fg-2">{title}</h2>
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </header>
  );
}

export function Stat({ label, value, hint, sub }: { label: string; value: ReactNode; hint?: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="label">{label}</div>
      <div className="num mt-0.5 truncate font-mono text-base font-medium tracking-tight">{value}</div>
      {sub && <div className="truncate text-2xs text-muted">{sub}</div>}
    </div>
  );
}

type Variant = "primary" | "secondary" | "ghost";

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110",
  secondary: "bg-surface text-fg ring-1 ring-inset ring-line-strong hover:bg-raised",
  ghost: "text-fg-2 hover:bg-raised hover:text-fg",
};

export function Button({ children, onClick, active, title, disabled, variant = "secondary", icon, className = "" }: {
  children?: ReactNode; onClick?: () => void; active?: boolean; title?: string; disabled?: boolean;
  variant?: Variant; icon?: ReactNode; className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex h-7 items-center gap-1.5 rounded-control px-2.5 text-xs font-medium whitespace-nowrap transition-[background-color,color,transform,filter] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 ${
        active ? "bg-accent-soft text-accent ring-1 ring-inset ring-accent/40" : VARIANT[variant]
      } ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}

const control =
  "h-7 rounded-control bg-surface text-xs text-fg ring-1 ring-inset ring-line-strong outline-none transition-shadow duration-150 placeholder:text-muted hover:ring-muted/60 focus:ring-2 focus:ring-accent";

export function TextInput({ icon, className = "", ...props }: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }) {
  return (
    <div className={`relative ${className}`}>
      {icon && <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted [&_svg]:size-3.5">{icon}</span>}
      <input {...props} className={`${control} w-full ${icon ? "pl-7" : "pl-2.5"} pr-2.5`} />
    </div>
  );
}

export function Select({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={`relative ${className}`}>
      <select {...props} className={`${control} w-full cursor-pointer appearance-none pr-7 pl-2.5`}>
        {children}
      </select>
      <Icon.ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted" />
    </div>
  );
}

export function DateInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="date" {...props} className={`${control} num px-2`} />;
}

export function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-fg-2 select-none">
      <span className={`relative h-4 w-7 rounded-full transition-colors duration-150 ${checked ? "bg-accent" : "bg-line-strong"}`}>
        <span className={`absolute top-0.5 left-0.5 size-3 rounded-full bg-white shadow transition-transform duration-150 ${checked ? "translate-x-3" : ""}`} />
      </span>
      <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-7 items-center rounded-control bg-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`h-6 rounded-[5px] px-2.5 text-xs font-medium transition-colors duration-150 ${
            o.value === value ? "bg-surface text-fg shadow-panel" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] bg-raised px-1 text-[10px] leading-none text-fg-2 ring-1 ring-inset ring-line-strong">
      {children}
    </kbd>
  );
}

/** Sticky page toolbar under the app header. */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-bg/80 px-5 py-2.5 backdrop-blur">{children}</div>;
}

export function Loading({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5" aria-busy aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="skeleton h-3 w-24" />
          <div className="skeleton h-3 flex-1" style={{ maxWidth: `${60 + ((i * 37) % 35)}%` }} />
          <div className="skeleton h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="enter mx-auto flex max-w-sm flex-col items-center px-6 py-16 text-center">
      {icon && <div className="mb-3 grid size-10 place-items-center rounded-panel bg-raised text-muted [&_svg]:size-5">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="mt-1 text-xs text-muted">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <div className="m-5 flex items-start gap-2 rounded-panel bg-risk-high-soft p-3 text-xs text-risk-high">
      <Icon.Alert className="mt-px size-4 shrink-0" />
      <span>{String(error instanceof Error ? error.message : error)}</span>
    </div>
  );
}

/** Small note required wherever a cost is shown. */
export function CostLabel() {
  return <span className="text-2xs font-normal tracking-normal text-muted">estimated, API-equivalent</span>;
}

/** Horizontal share bar used in breakdown tables. */
export function ShareBar({ value, max }: { value: number; max: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-raised">
      <div className="h-full rounded-full bg-accent/70" style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%` }} />
    </div>
  );
}
