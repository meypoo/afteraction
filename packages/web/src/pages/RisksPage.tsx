import { useState } from "react";
import { api } from "../api";
import { useMeta } from "../App";
import { Icon } from "../components/icons";
import { EmptyState, ErrorBox, Loading, RiskBadge, Segmented, Select, Toolbar, asRisk } from "../components/ui";
import { baseName, fmtDateTime } from "../format";
import { useAsync } from "../hooks";

const STRIPE: Record<string, string> = {
  none: "bg-line-strong",
  low: "bg-risk-low",
  medium: "bg-risk-medium",
  high: "bg-risk-high",
  critical: "bg-risk-critical",
};

export function RisksPage() {
  const meta = useMeta();
  const [level, setLevel] = useState<"low" | "medium" | "high" | "critical">("low");
  const [since, setSince] = useState("");
  const risks = useAsync(() => api.risks({ level, since: since || undefined }), [level, since]);
  const rows = risks.data?.risks ?? [];
  const rules = meta?.rules ?? [];
  const groups = rules.map((rule) => ({ rule, hits: rows.filter((r) => r.risk_rules.includes(rule.id)) })).filter((g) => g.hits.length);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-line px-5 pt-5 pb-4">
        <h1 className="text-lg font-semibold">Risks</h1>
        <p className="text-xs text-muted">
          Commands and file changes that matched a risk rule. Rules are heuristics, so check each hit before acting on it.
        </p>
      </div>
      <Toolbar>
        <Segmented
          label="Minimum severity"
          value={level}
          onChange={setLevel}
          options={[
            { value: "low", label: "All" },
            { value: "medium", label: "Medium+" },
            { value: "high", label: "High+" },
            { value: "critical", label: "Critical" },
          ]}
        />
        <Select value={since} onChange={(e) => setSince(e.target.value)} aria-label="Time range">
          <option value="">All time</option>
          <option value="1d">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </Select>
        <span className="num ml-auto font-mono text-2xs text-muted">
          {rows.length} flagged events · {groups.length} rules
        </span>
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-7xl space-y-4 p-5">
          {risks.error ? (
            <ErrorBox error={risks.error} />
          ) : !risks.data ? (
            <Loading />
          ) : groups.length === 0 ? (
            <EmptyState icon={<Icon.Check />} title="Nothing flagged">No events at this severity in the selected range.</EmptyState>
          ) : (
            groups.map(({ rule, hits }, gi) => (
              <section
                key={rule.id}
                className="enter relative overflow-hidden rounded-panel border border-line bg-surface shadow-panel"
                style={{ animationDelay: `${Math.min(gi, 8) * 30}ms` }}
              >
                <span className={`absolute inset-y-0 left-0 w-[3px] ${STRIPE[asRisk(rule.severity)]}`} />
                <header className="flex items-center gap-3 border-b border-line py-2.5 pr-4 pl-5">
                  <RiskBadge level={rule.severity} />
                  <h2 className="font-mono text-xs font-medium">{rule.id}</h2>
                  <span className="truncate text-xs text-muted">{rule.description}</span>
                  <span className="num ml-auto rounded-chip bg-raised px-1.5 font-mono text-2xs text-fg-2">{hits.length}</span>
                </header>
                <div>
                  {hits.map((h) => (
                    <a
                      key={`${rule.id}:${h.id}`}
                      href={`#/session/${encodeURIComponent(h.session_id)}?e=${h.seq}`}
                      className="group grid grid-cols-[8.5rem_8rem_minmax(0,1fr)_minmax(0,16rem)_1rem] items-center gap-4 border-b border-line/60 py-2 pr-4 pl-5 text-xs transition-colors last:border-0 hover:bg-raised/60"
                    >
                      <span className="num font-mono text-2xs text-muted">{fmtDateTime(h.ts)}</span>
                      <span className="truncate text-fg-2" title={h.project_path ?? ""}>{baseName(h.project_path)}</span>
                      <span className="truncate font-mono text-fg" title={h.summary}>{h.summary}</span>
                      <span className="truncate text-muted" title={h.title}>{h.title}</span>
                      <Icon.Chevron className="size-3.5 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
                    </a>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
