import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/icons";
import { CostLabel, DateInput, EmptyState, ErrorBox, Kbd, Loading, RiskBadge, Select, Stat, TextInput, Toolbar } from "../components/ui";
import { AGENT_LABEL, baseName, fmtCost, fmtDuration, fmtTokens } from "../format";
import { navigate, useAsync, useDebounced } from "../hooks";

const RISK_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

function day(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function clock(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function SessionsPage() {
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState("");
  const [project, setProject] = useState("");
  const [risk, setRisk] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const query = useDebounced(q, 250);
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses search, like most developer tools.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName)) {
        e.preventDefault();
        searchRef.current?.querySelector("input")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  const flagged = sessions.filter((s) => RISK_RANK[s.max_risk]! >= 3).length;
  const tokens = sessions.reduce((a, s) => a + s.total_input_tokens + s.total_output_tokens + s.total_cache_read_tokens + s.total_cache_write_tokens, 0);
  const filtered = !!(q || agent || project || risk || from || to);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-line px-5 pt-5 pb-4">
        <div className="flex flex-wrap items-start gap-x-10 gap-y-3">
          <div className="mr-auto">
            <h1 className="text-lg font-semibold">Sessions</h1>
            <p className="text-xs text-muted">Every agent session found on this machine, newest first.</p>
          </div>
          <Stat label="Sessions" value={sessions.length} />
          <Stat label="High risk or worse" value={<span className={flagged ? "text-risk-high" : ""}>{flagged}</span>} />
          <Stat label="Tokens" value={fmtTokens(tokens)} />
          <Stat
            label="Est. cost"
            value={fmtCost(total)}
            sub={priced.length < sessions.length ? `${sessions.length - priced.length} unpriced` : <CostLabel />}
            hint="Estimated, API-equivalent pricing"
          />
        </div>
      </div>

      <Toolbar>
        <div ref={searchRef} className="w-80 max-w-full">
          <TextInput
            icon={<Icon.Search />}
            placeholder="Search prompts, messages and commands"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search sessions"
          />
        </div>
        <Kbd>/</Kbd>
        <div className="mx-1 h-5 w-px bg-line" />
        <Select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
          <option value="">All agents</option>
          <option value="claude_code">Claude Code</option>
          <option value="codex">Codex</option>
        </Select>
        <Select className="max-w-56" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projects.data?.projects.map((p) => (
            <option key={p.project_path} value={p.project_path}>
              {baseName(p.project_path)} ({p.sessions})
            </option>
          ))}
        </Select>
        <Select value={risk} onChange={(e) => setRisk(e.target.value)} aria-label="Risk">
          <option value="">Any risk</option>
          <option value="low">Low or worse</option>
          <option value="medium">Medium or worse</option>
          <option value="high">High or worse</option>
          <option value="critical">Critical</option>
        </Select>
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <DateInput value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          <span>to</span>
          <DateInput value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </div>
        {filtered && (
          <button
            type="button"
            className="text-xs text-accent hover:underline"
            onClick={() => { setQ(""); setAgent(""); setProject(""); setRisk(""); setFrom(""); setTo(""); }}
          >
            Clear filters
          </button>
        )}
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto">
        {list.error ? (
          <ErrorBox error={list.error} />
        ) : list.loading && !list.data ? (
          <Loading />
        ) : sessions.length === 0 ? (
          <EmptyState icon={<Icon.Search />} title={filtered ? "No sessions match these filters" : "No sessions yet"}>
            {filtered ? "Try a shorter search or clear the filters." : <>Run <code>flightrec ingest</code>, or start with <code>flightrec --demo</code>.</>}
          </EmptyState>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-left">
            <thead className="sticky top-0 z-10 bg-bg">
              <tr className="[&>th]:border-b [&>th]:border-line [&>th]:py-2 [&>th]:label [&>th]:font-medium">
                <th className="w-28 pl-5">Started</th>
                <th>Session</th>
                <th className="w-20 text-right">Duration</th>
                <th className="w-20 text-right">Events</th>
                <th className="w-24 text-right">Tokens</th>
                <th className="w-24 text-right" title="Estimated, API-equivalent pricing">Est. cost</th>
                <th className="w-28 pr-5 pl-6">Risk</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const unpriced = JSON.parse(s.unpriced_models) as string[];
                const href = `#/session/${encodeURIComponent(s.id)}`;
                return (
                  <tr
                    key={s.id}
                    onClick={() => navigate(`/session/${encodeURIComponent(s.id)}`)}
                    className="group cursor-pointer transition-colors duration-100 hover:bg-surface [&>td]:border-b [&>td]:border-line/70 [&>td]:py-2.5"
                  >
                    <td className="pl-5 align-top">
                      <div className="num text-sm">{day(s.started_at)}</div>
                      <div className="num font-mono text-2xs text-muted">{clock(s.started_at)}</div>
                    </td>
                    <td className="max-w-0 pr-4 align-top">
                      <a href={href} onClick={(e) => e.stopPropagation()} className="block truncate text-sm font-medium group-hover:text-accent" title={s.title}>
                        {s.title}
                      </a>
                      <div className="mt-0.5 flex items-center gap-1.5 truncate text-2xs text-muted">
                        <span className="text-fg-2" title={s.project_path ?? ""}>{baseName(s.project_path)}</span>
                        {s.git_branch && <><span>·</span><span className="truncate font-mono">{s.git_branch}</span></>}
                        <span>·</span>
                        <span>{AGENT_LABEL[s.source] ?? s.source}</span>
                        {s.model && <><span>·</span><span className="font-mono">{s.model}</span></>}
                      </div>
                    </td>
                    <td className="num text-right align-top font-mono text-xs text-fg-2">{fmtDuration(s.started_at, s.ended_at)}</td>
                    <td className="num text-right align-top font-mono text-xs text-fg-2">{s.event_count}</td>
                    <td className="num text-right align-top font-mono text-xs text-fg-2">
                      {fmtTokens(s.total_input_tokens + s.total_output_tokens + s.total_cache_read_tokens + s.total_cache_write_tokens)}
                    </td>
                    <td
                      className="num text-right align-top font-mono text-xs"
                      title={unpriced.length ? `No price for: ${unpriced.join(", ")}` : "Estimated, API-equivalent pricing"}
                    >
                      {fmtCost(s.est_cost_usd)}
                    </td>
                    <td className="pr-5 pl-6 align-top"><RiskBadge level={s.max_risk} /></td>
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
