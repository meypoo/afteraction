import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type FileTouch, type NormalizedEvent } from "../api";
import { asAddedDiff, Diff } from "../components/Diff";
import { EventDetail } from "../components/EventDetail";
import { Icon } from "../components/icons";
import { KindIcon } from "../components/kinds";
import { Button, CostLabel, EmptyState, ErrorBox, Kbd, Loading, RiskBadge, Select, Stat, Toggle } from "../components/ui";
import { AGENT_LABEL, baseName, fmtCost, fmtDateTime, fmtDuration, fmtTime, fmtTokens, relPath, str } from "../format";
import { navigate, useAsync } from "../hooks";

const SPEEDS = [0.5, 1, 2, 4, 8];
const RISK_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const TICK_COLOR = ["", "bg-risk-low", "bg-risk-medium", "bg-risk-high", "bg-risk-critical"];

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
      setCopied("Copied to clipboard");
    } catch {
      setCopied("Copy failed");
    }
    setTimeout(() => setCopied(""), 2000);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-line bg-surface px-5 pt-4">
        <div className="flex items-start gap-3">
          <a href="#/" className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-raised hover:text-fg" title="Back to sessions">
            <Icon.Back className="size-4" />
          </a>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold" title={s.title}>{s.title}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
              <span className="text-fg-2">{baseName(s.project_path) || "—"}</span>
              {s.git_branch && <><span>·</span><span className="font-mono">{s.git_branch}</span></>}
              <span>·</span><span>{AGENT_LABEL[s.source] ?? s.source}</span>
              <span>·</span><span className="font-mono">{s.model ?? "unknown model"}</span>
              <span>·</span><span className="num">{fmtDateTime(s.started_at)}</span>
            </div>
          </div>
          <Button
            icon={copied ? <Icon.Check /> : <Icon.Copy />}
            onClick={() => void copyReceipt()}
            title="Markdown summary for a PR comment (secrets and home paths redacted)"
          >
            {copied || "Copy receipt"}
          </Button>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-x-6 gap-y-3 pl-10 md:grid-cols-6">
          <Stat label="Duration" value={fmtDuration(s.started_at, s.ended_at)} />
          <Stat
            label="Tokens in / out"
            value={`${fmtTokens(s.total_input_tokens)} / ${fmtTokens(s.total_output_tokens)}`}
            sub={`${fmtTokens(s.total_cache_read_tokens)} cache read`}
            hint={`${fmtTokens(s.total_cache_read_tokens)} cache read · ${fmtTokens(s.total_cache_write_tokens)} cache write`}
          />
          <Stat
            label="Est. cost"
            value={fmtCost(s.est_cost_usd)}
            sub={<CostLabel />}
            hint={unpriced.length ? `No price for: ${unpriced.join(", ")}` : "Estimated, API-equivalent pricing"}
          />
          <Stat label="Files touched" value={files.length} />
          <Stat label="Events" value={events.length} />
          <Stat label="Risks" value={<span className="flex items-center gap-2">{flagged} <RiskBadge level={s.max_risk} /></span>} />
        </div>
        <nav className="mt-3 flex gap-1 pl-8" aria-label="Session views">
          {[
            { href: `#${base}`, label: "Timeline", on: tab === "timeline" },
            { href: `#${base}/files`, label: `Files`, count: files.length, on: tab === "files" },
          ].map((t) => (
            <a
              key={t.label}
              href={t.href}
              aria-current={t.on ? "page" : undefined}
              className={`relative px-2 pb-2.5 text-sm transition-colors ${t.on ? "text-fg" : "text-muted hover:text-fg"}`}
            >
              {t.label}
              {t.count !== undefined && <span className="num ml-1.5 rounded-chip bg-raised px-1 font-mono text-2xs text-fg-2">{t.count}</span>}
              {t.on && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
            </a>
          ))}
        </nav>
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

/** The flight tape: every event as a tick, risks in colour, the selected event as the playhead. */
function Tape({ events, selectedSeq, onSelect }: { events: NormalizedEvent[]; selectedSeq: number | undefined; onSelect: (seq: number) => void }) {
  const buckets = useMemo(() => {
    const n = Math.min(events.length, 480);
    const out: { seq: number; risk: number; prompt: boolean; seqs: Set<number> }[] = [];
    for (let i = 0; i < n; i++) {
      const slice = events.slice(Math.floor((i * events.length) / n), Math.floor(((i + 1) * events.length) / n));
      out.push({
        seq: slice[0]!.seq,
        risk: Math.max(...slice.map((e) => RISK_RANK[e.risk_level] ?? 0)),
        prompt: slice.some((e) => e.kind === "user_message" && !e.payload.meta),
        seqs: new Set(slice.map((e) => e.seq)),
      });
    }
    return out;
  }, [events]);
  if (buckets.length < 2) return null;
  return (
    <div className="flex h-7 items-end justify-between gap-px border-b border-line bg-sunken px-3 pt-1.5 pb-1" role="slider" aria-label="Session tape" aria-valuenow={selectedSeq}>
      {buckets.map((b) => {
        const sel = selectedSeq !== undefined && b.seqs.has(selectedSeq);
        return (
          <button
            key={b.seq}
            type="button"
            tabIndex={-1}
            onClick={() => onSelect(b.seq)}
            className="group flex h-full max-w-1.5 min-w-px flex-1 items-end"
            title={`#${b.seq}`}
          >
            <span
              className={`w-full rounded-[1px] transition-all duration-100 group-hover:opacity-100 ${
                sel ? "h-full bg-accent" : b.risk ? `h-3/4 ${TICK_COLOR[b.risk]}` : b.prompt ? "h-3/5 bg-fg-2/60" : "h-1/3 bg-line-strong opacity-80"
              }`}
            />
          </button>
        );
      })}
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
      if (ev.key === "j" || ev.key === "ArrowDown") select(visible[Math.min(visible.length - 1, index + 1)]?.seq);
      else if (ev.key === "k" || ev.key === "ArrowUp") select(visible[Math.max(0, index - 1)]?.seq);
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
    <div className="flex h-full flex-col">
      <Tape events={visible} selectedSeq={selected?.seq} onSelect={select} />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[46%] min-w-[380px] flex-col border-r border-line">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2">
            <Button
              variant={playing ? "secondary" : "primary"}
              icon={playing ? <Icon.Pause /> : <Icon.Play />}
              onClick={() => setPlaying((p) => !p)}
              title="Play / pause (space)"
            >
              {playing ? "Pause" : "Play"}
            </Button>
            <Select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed" className="w-[4.5rem]">
              {SPEEDS.map((x) => <option key={x} value={x}>{x}×</option>)}
            </Select>
            <Toggle checked={showThinking} onChange={setShowThinking}>Thinking</Toggle>
            <Toggle checked={showMeta} onChange={setShowMeta}>Injected</Toggle>
            <span className="num ml-auto flex items-center gap-1.5 font-mono text-2xs text-muted" title="j / k: next / previous · r: next risk · space: play">
              {index + 1}/{visible.length}
              <span className="text-line-strong">|</span>
              <span className={riskCount ? "text-risk-high" : ""}>{riskCount} risks</span>
              <span className="ml-1 hidden items-center gap-0.5 xl:inline-flex"><Kbd>j</Kbd><Kbd>k</Kbd><Kbd>r</Kbd></span>
            </span>
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
            {visible.map((e) => {
              const nested = !!e.payload.subagent_id && e.kind !== "subagent_end";
              const isSel = e.seq === selected?.seq;
              const prompt = e.kind === "user_message" && !e.payload.meta;
              return (
                <div
                  key={e.id}
                  data-seq={e.seq}
                  onClick={() => select(e.seq)}
                  className={`relative mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-control py-1 pr-2 pl-2 transition-colors duration-100 ${
                    isSel ? "bg-accent-soft" : "hover:bg-surface"
                  } ${e.kind === "thinking" || e.payload.meta ? "opacity-60" : ""}`}
                >
                  {isSel && <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent" />}
                  <span className="num w-[3.75rem] shrink-0 font-mono text-2xs text-muted">{fmtTime(e.ts)}</span>
                  {nested && <span className="-mr-1 ml-1 h-5 w-px shrink-0 bg-risk-low/40" />}
                  <KindIcon kind={e.kind} />
                  <span
                    className={`min-w-0 flex-1 truncate ${prompt ? "font-medium" : ""} ${e.kind === "shell_command" ? "font-mono text-xs" : "text-sm"}`}
                    title={e.summary}
                  >
                    {e.summary}
                  </span>
                  {e.payload.is_error === true && <Icon.X className="size-3.5 shrink-0 text-risk-high" aria-label="failed" />}
                  {e.risk_level !== "none" && <RiskBadge level={e.risk_level} title={e.risk_rules.join(", ")} />}
                </div>
              );
            })}
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-auto bg-surface">
          {selected ? <EventDetail event={selected} projectPath={projectPath} /> : <EmptyState title="No events" />}
        </div>
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
        <table className="w-full table-fixed border-separate border-spacing-0 text-left">
          <thead className="sticky top-0 bg-bg">
            <tr className="[&>th]:border-b [&>th]:border-line [&>th]:py-2 [&>th]:label [&>th]:font-medium">
              <th className="pl-4">File</th>
              <th className="w-16 text-right">Reads</th>
              <th className="w-16 text-right">Writes</th>
              <th className="w-16 pr-4 text-right">Edits</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => {
              const on = f.path === path;
              return (
                <tr
                  key={f.path}
                  onClick={() => setPath(f.path)}
                  className={`cursor-pointer transition-colors [&>td]:border-b [&>td]:border-line/60 [&>td]:py-2 ${on ? "bg-accent-soft" : "hover:bg-surface"}`}
                >
                  <td className="truncate pl-4 font-mono text-xs" title={f.path}>
                    <FileName path={relPath(f.path, projectPath)} />
                  </td>
                  <td className="num text-right font-mono text-xs text-fg-2">{f.reads || ""}</td>
                  <td className="num text-right font-mono text-xs text-ok">{f.writes || ""}</td>
                  <td className="num pr-4 text-right font-mono text-xs text-ok">{f.edits || ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="min-w-0 flex-1 space-y-5 overflow-auto bg-surface p-5">
        {!path ? (
          <EmptyState icon={<Icon.FileRead />} title="Pick a file">Every change the agent made to it shows here, in order.</EmptyState>
        ) : changes.length === 0 ? (
          <EmptyState icon={<Icon.FileRead />} title={`${baseName(path)} was only read`}>This session never wrote to it.</EmptyState>
        ) : (
          changes.map((e) => {
            const diff = str(e.payload.unified_diff) || (e.kind === "file_write" && e.payload.content_excerpt ? asAddedDiff(str(e.payload.content_excerpt)) : "");
            return (
              <div key={e.id} className="enter space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted">
                  <KindIcon kind={e.kind} />
                  <span className="text-fg-2">{e.kind === "file_write" ? "Write" : "Edit"}</span>
                  <span className="num font-mono">#{e.seq} · {fmtTime(e.ts)}</span>
                  {e.payload.is_error === true && <span className="text-risk-high">failed</span>}
                  <a className="ml-auto inline-flex items-center gap-0.5 text-accent hover:underline" href={`#/session/${encodeURIComponent(e.session_id)}?e=${e.seq}`}>
                    Open in timeline <Icon.Chevron className="size-3" />
                  </a>
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
