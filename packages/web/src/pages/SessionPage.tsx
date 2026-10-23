import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type FileTouch, type NormalizedEvent } from "../api";
import { asAddedDiff, Diff } from "../components/Diff";
import { EventDetail } from "../components/EventDetail";
import { Button, CostLabel, ErrorBox, Loading, RiskBadge, Stat } from "../components/ui";
import { AGENT_LABEL, baseName, fmtCost, fmtDateTime, fmtDuration, fmtTime, fmtTokens, relPath, str } from "../format";
import { navigate, useAsync } from "../hooks";

const ICON: Record<string, string> = {
  user_message: "👤",
  assistant_message: "💬",
  thinking: "💭",
  tool_call: "🔧",
  tool_result: "↩",
  shell_command: "❯",
  file_read: "📄",
  file_write: "📝",
  file_edit: "✏️",
  web_fetch: "🌐",
  subagent_start: "🤖",
  subagent_end: "🏁",
  error: "⚠",
  unknown: "?",
};

const SPEEDS = [0.5, 1, 2, 4, 8];

export function SessionPage({ id, tab, params }: { id: string; tab: "timeline" | "files"; params: URLSearchParams }) {
  const detail = useAsync(() => api.session(id), [id]);
  const evs = useAsync(() => api.events(id), [id]);
  const [copied, setCopied] = useState<string>("");

  if (detail.error) return <ErrorBox error={detail.error} />;
  if (evs.error) return <ErrorBox error={evs.error} />;
  if (!detail.data || !evs.data) return <Loading />;

  const { session: s, files } = detail.data;
  const events = evs.data.events;
  const flagged = events.filter((e) => e.risk_level !== "none").length;
  const unpriced = JSON.parse(s.unpriced_models) as string[];
  const base = `/session/${encodeURIComponent(id)}`;

  const copyReceipt = async () => {
    try {
      await navigator.clipboard.writeText(await api.receipt(id));
      setCopied("Copied");
    } catch {
      setCopied("Copy failed");
    }
    setTimeout(() => setCopied(""), 2000);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-2 border-b border-line bg-panel px-4 py-3">
        <div className="flex items-start gap-3">
          <a href="#/" className="text-muted hover:text-fg" title="Back to sessions">←</a>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold" title={s.title}>{s.title}</h1>
            <div className="truncate text-xs text-muted">
              {AGENT_LABEL[s.source] ?? s.source} · {s.model ?? "unknown model"} · {s.project_path ?? "—"}
              {s.git_branch ? ` (${s.git_branch})` : ""} · {fmtDateTime(s.started_at)}
            </div>
          </div>
          <Button onClick={() => void copyReceipt()} title="Markdown summary for a PR comment (secrets and home paths redacted)">
            {copied || "Copy receipt"}
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
          <Stat label="Duration" value={fmtDuration(s.started_at, s.ended_at)} />
          <Stat
            label="Tokens"
            value={`${fmtTokens(s.total_input_tokens + s.total_output_tokens)} in/out`}
            hint={`${fmtTokens(s.total_cache_read_tokens)} cache read · ${fmtTokens(s.total_cache_write_tokens)} cache write`}
          />
          <Stat
            label="Est. cost"
            value={<>{fmtCost(s.est_cost_usd)} <CostLabel /></>}
            hint={unpriced.length ? `No price for: ${unpriced.join(", ")}` : "Estimated, API-equivalent pricing"}
          />
          <Stat label="Files touched" value={files.length} />
          <Stat label="Events" value={events.length} />
          <Stat label="Risks" value={<span className="flex items-center gap-2">{flagged} <RiskBadge level={s.max_risk} /></span>} />
        </div>
        <div className="flex gap-1">
          <a href={`#${base}`} className={`rounded px-2.5 py-1 text-xs ${tab === "timeline" ? "bg-raised" : "text-muted hover:text-fg"}`}>Timeline</a>
          <a href={`#${base}/files`} className={`rounded px-2.5 py-1 text-xs ${tab === "files" ? "bg-raised" : "text-muted hover:text-fg"}`}>
            Files ({files.length})
          </a>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {tab === "timeline" ? (
          <Timeline events={events} projectPath={s.project_path} params={params} base={base} />
        ) : (
          <FilesTab files={files} events={events} projectPath={s.project_path} />
        )}
      </div>
    </div>
  );
}

function Timeline({ events, projectPath, params, base }: {
  events: NormalizedEvent[]; projectPath: string | null; params: URLSearchParams; base: string;
}) {
  const [showThinking, setShowThinking] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const listRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () =>
      events.filter(
        (e) => (showThinking || e.kind !== "thinking") && (showMeta || !(e.kind === "user_message" && e.payload.meta === true)),
      ),
    [events, showThinking, showMeta],
  );

  const requested = Number(params.get("e"));
  const selectedSeq = Number.isFinite(requested) && params.has("e") ? requested : visible[0]?.seq;
  const found = visible.findIndex((e) => e.seq === selectedSeq);
  const index = Math.max(0, found);
  // A linked event may be hidden by the filters; still show it in the detail pane.
  const selected = found >= 0 ? visible[found] : (events.find((e) => e.seq === selectedSeq) ?? visible[0]);

  const select = useCallback((seq: number | undefined) => {
    if (seq !== undefined) navigate(`${base}?e=${seq}`, true);
  }, [base]);

  // j/k: next/previous event, r: next risk, space: play/pause.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === "j") select(visible[Math.min(visible.length - 1, index + 1)]?.seq);
      else if (ev.key === "k") select(visible[Math.max(0, index - 1)]?.seq);
      else if (ev.key === "r") {
        const risky = visible.filter((e) => e.risk_level !== "none");
        const next = risky.find((e) => e.seq > (selected?.seq ?? -1)) ?? risky[0];
        select(next?.seq);
      } else if (ev.key === " ") setPlaying((p) => !p);
      else return;
      ev.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, index, selected, select]);

  // Play mode: advance one event per tick.
  useEffect(() => {
    if (!playing) return;
    if (index >= visible.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => select(visible[index + 1]?.seq), 1000 / speed);
    return () => clearTimeout(t);
  }, [playing, index, visible, speed, select]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-seq="${selected?.seq}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected?.seq]);

  const riskCount = visible.filter((e) => e.risk_level !== "none").length;

  return (
    <div className="flex h-full">
      <div className="flex w-[46%] min-w-[380px] flex-col border-r border-line">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
          <Button onClick={() => setPlaying((p) => !p)} active={playing} title="Space">{playing ? "❚❚ Pause" : "▶ Play"}</Button>
          <select className="rounded border border-line bg-panel px-1 py-0.5" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed">
            {SPEEDS.map((x) => <option key={x} value={x}>{x}×</option>)}
          </select>
          <label className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} /> thinking
          </label>
          <label className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={showMeta} onChange={(e) => setShowMeta(e.target.checked)} /> injected messages
          </label>
          <span className="ml-auto text-muted" title="j / k: next / previous · r: next risk · space: play">
            {index + 1}/{visible.length} · {riskCount} risks · <kbd>j</kbd>/<kbd>k</kbd> <kbd>r</kbd>
          </span>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto font-mono text-xs">
          {visible.map((e) => {
            const nested = !!e.payload.subagent_id && e.kind !== "subagent_end";
            const isSel = e.seq === selected?.seq;
            return (
              <div
                key={e.id}
                data-seq={e.seq}
                onClick={() => select(e.seq)}
                className={`flex cursor-pointer items-center gap-2 border-b border-line/40 px-3 py-1 ${
                  isSel ? "bg-accent/15" : "hover:bg-raised"
                } ${e.kind === "thinking" || e.payload.meta ? "text-muted" : ""}`}
              >
                <span className="w-14 shrink-0 tabular-nums text-muted">{fmtTime(e.ts)}</span>
                <span className={`w-5 shrink-0 text-center ${nested ? "ml-4" : ""}`} title={e.kind}>{ICON[e.kind] ?? "·"}</span>
                <span className="min-w-0 flex-1 truncate font-sans" title={e.summary}>
                  {e.summary}
                </span>
                {e.payload.is_error === true && <span className="text-red-500" title="failed">✗</span>}
                {e.risk_level !== "none" && <RiskBadge level={e.risk_level} title={e.risk_rules.join(", ")} />}
              </div>
            );
          })}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {selected ? <EventDetail event={selected} projectPath={projectPath} /> : <div className="p-6 text-muted">No events.</div>}
      </div>
    </div>
  );
}

/** File name first, directory dimmed after it, so truncation never hides the name. */
function FileName({ path }: { path: string }) {
  const parts = path.split(/[\\/]/);
  const name = parts.pop() ?? path;
  const dir = parts.join("/");
  return (
    <>
      <span>{name}</span>
      {dir && <span className="ml-2 text-muted">{dir}</span>}
    </>
  );
}

function FilesTab({ files, events, projectPath }: { files: FileTouch[]; events: NormalizedEvent[]; projectPath: string | null }) {
  const [path, setPath] = useState<string | null>(null);
  const changes = events.filter((e) => str(e.payload.path) === path && (e.kind === "file_write" || e.kind === "file_edit"));

  return (
    <div className="flex h-full">
      <div className="w-[46%] min-w-[380px] overflow-auto border-r border-line">
        <table className="w-full table-fixed text-left text-xs">
          <thead className="sticky top-0 bg-panel text-[11px] uppercase tracking-wide text-muted">
            <tr className="border-b border-line">
              <th className="px-3 py-2 font-medium">File</th>
              <th className="w-16 px-2 py-2 text-right font-medium">Reads</th>
              <th className="w-16 px-2 py-2 text-right font-medium">Writes</th>
              <th className="w-16 px-3 py-2 text-right font-medium">Edits</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr
                key={f.path}
                onClick={() => setPath(f.path)}
                className={`cursor-pointer border-b border-line/40 ${f.path === path ? "bg-accent/15" : "hover:bg-raised"}`}
              >
                <td className="truncate px-3 py-1.5 font-mono" title={f.path}>
                  <FileName path={relPath(f.path, projectPath)} />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{f.reads || ""}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{f.writes || ""}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{f.edits || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="min-w-0 flex-1 space-y-4 overflow-auto p-4">
        {!path ? (
          <div className="text-muted">Pick a file to see every change the agent made to it, in order.</div>
        ) : changes.length === 0 ? (
          <div className="text-muted">{baseName(path)} was only read in this session.</div>
        ) : (
          changes.map((e) => {
            const diff = str(e.payload.unified_diff) || (e.kind === "file_write" && e.payload.content_excerpt ? asAddedDiff(str(e.payload.content_excerpt)) : "");
            return (
              <div key={e.id} className="space-y-1">
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span>{e.kind === "file_write" ? "Write" : "Edit"} #{e.seq} · {fmtTime(e.ts)}</span>
                  {e.payload.is_error === true && <span className="text-red-500">failed</span>}
                  <a className="ml-auto text-accent hover:underline" href={`#/session/${encodeURIComponent(e.session_id)}?e=${e.seq}`}>open in timeline</a>
                </div>
                {diff ? <Diff text={diff} path={path} /> : <div className="text-xs text-muted">No diff recorded.</div>}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
