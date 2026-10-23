import { useState } from "react";
import { api } from "../api";
import { useMeta } from "../App";
import { ErrorBox, inputClass, Loading, RiskBadge } from "../components/ui";
import { baseName, fmtDateTime } from "../format";
import { useAsync } from "../hooks";

export function RisksPage() {
  const meta = useMeta();
  const [level, setLevel] = useState("low");
  const [since, setSince] = useState("");
  const risks = useAsync(() => api.risks({ level, since: since || undefined }), [level, since]);
  const rows = risks.data?.risks ?? [];
  const rules = meta?.rules ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <select className={inputClass} value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Minimum severity">
          <option value="low">Low or worse</option>
          <option value="medium">Medium or worse</option>
          <option value="high">High or worse</option>
          <option value="critical">Critical</option>
        </select>
        <select className={inputClass} value={since} onChange={(e) => setSince(e.target.value)} aria-label="Time range">
          <option value="">All time</option>
          <option value="1d">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
        <span className="ml-auto text-xs text-muted">
          {rows.length} flagged events · rules are heuristics, so check each hit before acting on it
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {risks.error ? (
          <ErrorBox error={risks.error} />
        ) : !risks.data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <div className="text-muted">No flagged events.</div>
        ) : (
          rules.map((rule) => {
            const hits = rows.filter((r) => r.risk_rules.includes(rule.id));
            if (!hits.length) return null;
            return (
              <section key={rule.id} className="rounded-md border border-line bg-panel">
                <header className="flex items-center gap-2 border-b border-line px-3 py-2">
                  <RiskBadge level={rule.severity} />
                  <span className="font-mono text-xs">{rule.id}</span>
                  <span className="text-xs text-muted">{rule.description}</span>
                  <span className="ml-auto text-xs text-muted">{hits.length}</span>
                </header>
                <div>
                  {hits.map((h) => (
                    <a
                      key={`${rule.id}:${h.id}`}
                      href={`#/session/${encodeURIComponent(h.session_id)}?e=${h.seq}`}
                      className="flex items-center gap-3 border-b border-line/40 px-3 py-1.5 text-xs last:border-0 hover:bg-raised"
                    >
                      <span className="w-32 shrink-0 tabular-nums text-muted">{fmtDateTime(h.ts)}</span>
                      <span className="w-32 shrink-0 truncate" title={h.project_path ?? ""}>{baseName(h.project_path)}</span>
                      <span className="min-w-0 flex-1 truncate font-mono" title={h.summary}>{h.summary}</span>
                      <span className="max-w-64 shrink-0 truncate text-muted" title={h.title}>{h.title}</span>
                    </a>
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
