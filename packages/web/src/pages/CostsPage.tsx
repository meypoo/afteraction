import { useState } from "react";
import { api } from "../api";
import { useMeta } from "../App";
import { ErrorBox, inputClass, Loading, Panel } from "../components/ui";
import { baseName, fmtCost, fmtDateTime, fmtTokens } from "../format";
import { useAsync } from "../hooks";

export function CostsPage() {
  const meta = useMeta();
  const [since, setSince] = useState("30d");
  const costs = useAsync(() => api.costs(since || undefined), [since]);
  const c = costs.data;
  const maxDay = Math.max(0.01, ...(c?.by_day.map((d) => d.usd) ?? [0]));

  return (
    <div className="h-full overflow-auto">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <select className={inputClass} value={since} onChange={(e) => setSince(e.target.value)} aria-label="Time range">
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="">All time</option>
        </select>
        <span className="text-xs text-muted">
          {c?.cost_label ?? "Estimated, API-equivalent pricing"}. Subscription plans don't bill per token.
          {meta && ` Prices as of ${meta.prices.last_updated}${meta.prices.confirmed ? "" : " (not yet confirmed)"}.`}
        </span>
      </div>
      {costs.error ? (
        <ErrorBox error={costs.error} />
      ) : !c ? (
        <Loading />
      ) : (
        <div className="space-y-4 p-4">
          <div className="flex items-baseline gap-3">
            <div className="text-2xl font-semibold tabular-nums">{fmtCost(c.total_usd)}</div>
            <div className="text-xs text-muted">
              estimated, API-equivalent
              {c.unpriced_sessions > 0 && ` · ${c.unpriced_sessions} sessions left out (model without a price)`}
            </div>
          </div>

          <Panel className="p-3">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-muted">By day (UTC)</div>
            {c.by_day.length === 0 ? (
              <div className="text-muted">No priced activity in this range.</div>
            ) : (
              <div className="flex h-48 items-end gap-px">
                {c.by_day.map((d) => (
                  <div key={d.day} className="group relative flex h-full min-w-1 flex-1 items-end" title={`${d.day}: ${fmtCost(d.usd)}`}>
                    <div className="w-full rounded-t-sm bg-accent/70 group-hover:bg-accent" style={{ height: `${Math.max(1, (d.usd / maxDay) * 100)}%` }} />
                  </div>
                ))}
              </div>
            )}
            {c.by_day.length > 0 && (
              <div className="mt-1 flex justify-between text-[11px] text-muted">
                <span>{c.by_day[0]!.day}</span>
                <span>max {fmtCost(maxDay)}/day</span>
                <span>{c.by_day.at(-1)!.day}</span>
              </div>
            )}
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <div className="border-b border-line px-3 py-2 text-[11px] uppercase tracking-wide text-muted">By project</div>
              <table className="w-full text-xs">
                <tbody>
                  {c.by_project.map((p) => (
                    <tr key={p.project_path ?? "none"} className="border-b border-line/40 last:border-0">
                      <td className="px-3 py-1.5" title={p.project_path ?? ""}>{baseName(p.project_path)}</td>
                      <td className="px-2 py-1.5 text-right text-muted">{p.sessions} sessions</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtCost(p.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <Panel>
              <div className="border-b border-line px-3 py-2 text-[11px] uppercase tracking-wide text-muted">By model</div>
              <table className="w-full text-xs">
                <tbody>
                  {c.by_model.map((m) => (
                    <tr key={m.model} className="border-b border-line/40 last:border-0">
                      <td className="px-3 py-1.5 font-mono">{m.model}</td>
                      <td className="px-2 py-1.5 text-right text-muted">{fmtTokens(m.tokens)} tokens</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtCost(m.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>

          <Panel>
            <div className="border-b border-line px-3 py-2 text-[11px] uppercase tracking-wide text-muted">Most expensive sessions</div>
            {c.top_sessions.map((s) => (
              <a
                key={s.id}
                href={`#/session/${encodeURIComponent(s.id)}`}
                className="flex items-center gap-3 border-b border-line/40 px-3 py-1.5 text-xs last:border-0 hover:bg-raised"
              >
                <span className="w-32 shrink-0 tabular-nums text-muted">{fmtDateTime(s.started_at)}</span>
                <span className="w-32 shrink-0 truncate">{baseName(s.project_path)}</span>
                <span className="min-w-0 flex-1 truncate" title={s.title}>{s.title}</span>
                <span className="w-20 shrink-0 text-right tabular-nums">{fmtCost(s.est_cost_usd)}</span>
              </a>
            ))}
          </Panel>
        </div>
      )}
    </div>
  );
}
