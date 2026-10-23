import { useState } from "react";
import { api } from "../api";
import { useMeta } from "../App";
import { Icon } from "../components/icons";
import { EmptyState, ErrorBox, Loading, Panel, PanelHeader, Segmented, ShareBar, Stat } from "../components/ui";
import { baseName, fmtCost, fmtTokens } from "../format";
import { useAsync } from "../hooks";

type Range = "7d" | "30d" | "90d" | "all";

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Round a max up to a friendly axis value (1, 2, 5 × 10^n). */
function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= v) ?? v;
}

export function CostsPage() {
  const meta = useMeta();
  const [range, setRange] = useState<Range>("30d");
  const since = range === "all" ? undefined : range;
  const costs = useAsync(() => api.costs(since), [since]);
  const [hover, setHover] = useState<number | null>(null);
  const c = costs.data;
  const axisMax = niceMax(Math.max(0.01, ...(c?.by_day.map((d) => d.usd) ?? [0])));
  const activeDays = c?.by_day.filter((d) => d.usd > 0).length ?? 0;
  const maxProject = Math.max(0, ...(c?.by_project.map((p) => p.usd) ?? [0]));
  const maxModel = Math.max(0, ...(c?.by_model.map((m) => m.usd) ?? [0]));
  const hovered = hover !== null ? c?.by_day[hover] : undefined;

  return (
    <div className="h-full overflow-auto">
      <div className="border-b border-line px-5 pt-5 pb-4">
        <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
          <div className="mr-auto">
            <h1 className="text-lg font-semibold">Costs</h1>
            <p className="max-w-[65ch] text-xs text-muted">
              {c?.cost_label ?? "Estimated, API-equivalent pricing"}. Subscription plans don't bill per token.
              {meta && ` Prices as of ${meta.prices.last_updated}${meta.prices.confirmed ? "" : " (not yet confirmed)"}.`}
            </p>
          </div>
          <Segmented
            label="Time range"
            value={range}
            onChange={setRange}
            options={[
              { value: "7d", label: "7 days" },
              { value: "30d", label: "30 days" },
              { value: "90d", label: "90 days" },
              { value: "all", label: "All" },
            ]}
          />
        </div>
      </div>
      {costs.error ? (
        <ErrorBox error={costs.error} />
      ) : !c ? (
        <Loading />
      ) : (
        <div className="max-w-7xl space-y-5 p-5">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
            <Stat label="Total, estimated" value={<span className="text-2xl">{fmtCost(c.total_usd)}</span>} sub="API-equivalent" />
            <Stat label="Active days" value={activeDays} sub={activeDays ? `${fmtCost(c.total_usd / activeDays)} per active day` : "—"} />
            <Stat label="Projects" value={c.by_project.length} />
            <Stat
              label="Left out"
              value={c.unpriced_sessions}
              sub={c.unpriced_sessions ? "sessions with an unpriced model" : "every session priced"}
            />
          </div>

          <Panel>
            <PanelHeader title="Spend by day (UTC)">
              <span className="num font-mono text-2xs text-muted">
                {hovered ? `${shortDay(hovered.day)} · ${fmtCost(hovered.usd)}` : `axis max ${fmtCost(axisMax)}`}
              </span>
            </PanelHeader>
            {c.by_day.length === 0 ? (
              <EmptyState icon={<Icon.Dot />} title="No priced activity in this range" />
            ) : (
              <div className="px-4 pt-4 pb-3">
                <div className="relative h-52" onMouseLeave={() => setHover(null)}>
                  {[1, 0.5, 0].map((f) => (
                    <div key={f} className="absolute inset-x-0 flex translate-y-1/2 items-center gap-2" style={{ bottom: `${f * 100}%` }}>
                      <div className="h-px flex-1 border-t border-dashed border-line" />
                      <span className="num w-12 -translate-y-px text-right font-mono text-[10px] text-muted">{fmtCost(axisMax * f)}</span>
                    </div>
                  ))}
                  <div className="absolute inset-y-0 right-14 left-0 flex items-end justify-around gap-[3px]">
                    {c.by_day.map((d, i) => (
                      <div
                        key={d.day}
                        className="flex h-full max-w-12 min-w-[3px] flex-1 cursor-default items-end"
                        onMouseEnter={() => setHover(i)}
                        title={`${d.day}: ${fmtCost(d.usd)}`}
                      >
                        <div
                          className={`w-full rounded-t-[3px] transition-colors duration-100 ${hover === i ? "bg-accent" : "bg-accent/55"}`}
                          style={{ height: `${d.usd > 0 ? Math.max(1.5, (d.usd / axisMax) * 100) : 0}%` }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="num mt-2 mr-14 flex justify-between font-mono text-[10px] text-muted">
                  <span>{shortDay(c.by_day[0]!.day)}</span>
                  <span>{shortDay(c.by_day.at(-1)!.day)}</span>
                </div>
              </div>
            )}
          </Panel>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel>
              <PanelHeader title="By project" />
              {c.by_project.map((p) => (
                <div key={p.project_path ?? "none"} className="grid grid-cols-[minmax(0,1fr)_5rem_4.5rem] items-center gap-3 border-b border-line/60 px-4 py-2 text-xs last:border-0">
                  <div className="min-w-0">
                    <div className="truncate font-medium" title={p.project_path ?? ""}>{baseName(p.project_path) || "No project"}</div>
                    <div className="mt-1"><ShareBar value={p.usd} max={maxProject} /></div>
                  </div>
                  <span className="num text-right text-muted">{p.sessions} {p.sessions === 1 ? "session" : "sessions"}</span>
                  <span className="num text-right font-mono">{fmtCost(p.usd)}</span>
                </div>
              ))}
            </Panel>
            <Panel>
              <PanelHeader title="By model" />
              {c.by_model.map((m) => (
                <div key={m.model} className="grid grid-cols-[minmax(0,1fr)_5rem_4.5rem] items-center gap-3 border-b border-line/60 px-4 py-2 text-xs last:border-0">
                  <div className="min-w-0">
                    <div className="truncate font-mono">{m.model}</div>
                    <div className="mt-1"><ShareBar value={m.usd} max={maxModel} /></div>
                  </div>
                  <span className="num text-right text-muted">{fmtTokens(m.tokens)} tok</span>
                  <span className="num text-right font-mono">{fmtCost(m.usd)}</span>
                </div>
              ))}
            </Panel>
          </div>

          <Panel>
            <PanelHeader title="Most expensive sessions" />
            {c.top_sessions.map((s, i) => (
              <a
                key={s.id}
                href={`#/session/${encodeURIComponent(s.id)}`}
                className="group grid grid-cols-[1.5rem_5.5rem_8rem_minmax(0,1fr)_5rem] items-center gap-3 border-b border-line/60 px-4 py-2 text-xs transition-colors last:border-0 hover:bg-raised/60"
              >
                <span className="num font-mono text-muted">{i + 1}</span>
                <span className="num font-mono text-2xs text-muted">{s.started_at ? shortDay(s.started_at.slice(0, 10)) : "—"}</span>
                <span className="truncate text-fg-2">{baseName(s.project_path)}</span>
                <span className="truncate group-hover:text-accent" title={s.title}>{s.title}</span>
                <span className="num text-right font-mono">{fmtCost(s.est_cost_usd)}</span>
              </a>
            ))}
          </Panel>
        </div>
      )}
    </div>
  );
}
