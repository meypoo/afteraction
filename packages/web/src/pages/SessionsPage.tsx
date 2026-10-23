import { useState } from "react";
import { api } from "../api";
import { CostLabel, ErrorBox, inputClass, Loading, RiskBadge } from "../components/ui";
import { AGENT_LABEL, baseName, fmtCost, fmtDateTime, fmtDuration, fmtTokens } from "../format";
import { navigate, useAsync, useDebounced } from "../hooks";

export function SessionsPage() {
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState("");
  const [project, setProject] = useState("");
  const [risk, setRisk] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const query = useDebounced(q, 250);

  const projects = useAsync(() => api.projects(), []);
  // `to` is inclusive in the UI: sessions started before the next day.
  const until = to ? new Date(Date.parse(to) + 86400e3).toISOString().slice(0, 10) : undefined;
  const list = useAsync(
    () => api.sessions({ q: query || undefined, agent, project, risk, since: from || undefined, until }),
    [query, agent, project, risk, from, until],
  );

  const sessions = list.data?.sessions ?? [];
  const priced = sessions.filter((s) => s.est_cost_usd !== null);
  const total = priced.reduce((a, s) => a + (s.est_cost_usd ?? 0), 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <input
          className={`${inputClass} w-72`}
          placeholder="Search prompts and commands…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <select className={inputClass} value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
          <option value="">All agents</option>
          <option value="claude_code">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <select className={`${inputClass} max-w-56`} value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projects.data?.projects.map((p) => (
            <option key={p.project_path} value={p.project_path}>
              {baseName(p.project_path)} ({p.sessions})
            </option>
          ))}
        </select>
        <select className={inputClass} value={risk} onChange={(e) => setRisk(e.target.value)} aria-label="Risk">
          <option value="">Any risk</option>
          <option value="low">Low or worse</option>
          <option value="medium">Medium or worse</option>
          <option value="high">High or worse</option>
          <option value="critical">Critical</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-muted">
          From <input type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted">
          To <input type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <div className="ml-auto text-xs text-muted">
          {sessions.length} sessions · {fmtCost(total)} <CostLabel />
          {priced.length < sessions.length && ` · ${sessions.length - priced.length} unpriced`}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {list.error ? (
          <ErrorBox error={list.error} />
        ) : list.loading && !list.data ? (
          <Loading />
        ) : sessions.length === 0 ? (
          <div className="p-6 text-muted">No sessions match. Run <code>flightrec ingest</code> or loosen the filters.</div>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-panel text-[11px] uppercase tracking-wide text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Started</th>
                <th className="px-2 py-2 font-medium">Agent</th>
                <th className="px-2 py-2 font-medium">Project</th>
                <th className="px-2 py-2 font-medium">Title</th>
                <th className="px-2 py-2 text-right font-medium">Duration</th>
                <th className="px-2 py-2 text-right font-medium">Events</th>
                <th className="px-2 py-2 text-right font-medium">Tokens</th>
                <th className="px-2 py-2 text-right font-medium" title="Estimated, API-equivalent pricing">Est. cost</th>
                <th className="px-4 py-2 font-medium">Risk</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const unpriced = JSON.parse(s.unpriced_models) as string[];
                return (
                  <tr
                    key={s.id}
                    onClick={() => navigate(`/session/${encodeURIComponent(s.id)}`)}
                    className="cursor-pointer border-b border-line/60 hover:bg-raised"
                  >
                    <td className="whitespace-nowrap px-4 py-1.5 tabular-nums text-muted">{fmtDateTime(s.started_at)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">{AGENT_LABEL[s.source] ?? s.source}</td>
                    <td className="max-w-40 truncate px-2 py-1.5" title={s.project_path ?? ""}>{baseName(s.project_path)}</td>
                    <td className="max-w-[36rem] truncate px-2 py-1.5" title={s.title}>{s.title}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{fmtDuration(s.started_at, s.ended_at)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{s.event_count}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {fmtTokens(s.total_input_tokens + s.total_output_tokens + s.total_cache_read_tokens + s.total_cache_write_tokens)}
                    </td>
                    <td
                      className="px-2 py-1.5 text-right tabular-nums"
                      title={unpriced.length ? `No price for: ${unpriced.join(", ")}` : "Estimated, API-equivalent pricing"}
                    >
                      {fmtCost(s.est_cost_usd)}
                    </td>
                    <td className="px-4 py-1.5"><RiskBadge level={s.max_risk} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
