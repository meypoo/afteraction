// Full-screen terminal browser (`afteraction tui`): a session list, then a session's timeline and event detail,
// with the same j/k/r keys as the web UI. Colours follow the web UI's "Instrument" dark palette (packages/web/DESIGN.md):
// neutral chrome, one teal accent for what you're looking at, and colour otherwise only for risk and diffs.
import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";
import {
  AGENT_LABELS,
  baseName,
  COST_LABEL,
  fmtDateTime,
  fmtDuration,
  fmtTime,
  fmtTokens,
  maskSecrets,
  riskRank,
  RULES,
  safeTerminalDeep,
  truncate,
  type NormalizedEvent,
  type RiskLevel,
  type SessionRow,
} from "@afteraction/core";

export const COLOR = {
  fg: "#e7e9ec",
  fg2: "#a6acb6",
  muted: "#6f7682",
  line: "#30353e",
  raised: "#1a1d22",
  accent: "#5cc4b5",
  ok: "#4cc38a",
  brand: "#f0592a",
};

const RISK_COLOR: Record<RiskLevel, string> = { none: COLOR.muted, low: "#8ea6c8", medium: "#e2b34d", high: "#f0706a", critical: "#e5484d" };

const KIND: Record<string, { label: string; color: string }> = {
  user_message: { label: "Prompt", color: COLOR.accent },
  assistant_message: { label: "Message", color: COLOR.fg2 },
  thinking: { label: "Thinking", color: COLOR.muted },
  tool_call: { label: "Tool", color: COLOR.fg2 },
  tool_result: { label: "Result", color: COLOR.fg2 },
  shell_command: { label: "Command", color: COLOR.fg },
  file_read: { label: "Read", color: COLOR.fg2 },
  file_write: { label: "Write", color: COLOR.ok },
  file_edit: { label: "Edit", color: COLOR.ok },
  web_fetch: { label: "Fetch", color: COLOR.fg2 },
  subagent_start: { label: "Subagent", color: RISK_COLOR.low },
  subagent_end: { label: "Agent done", color: RISK_COLOR.low },
  error: { label: "Error", color: RISK_COLOR.high },
  unknown: { label: "Other", color: COLOR.muted },
};
const kindOf = (k: string) => KIND[k] ?? KIND.unknown!;

const AGENT_LABEL: Record<string, string> = AGENT_LABELS;

export const fmtCost = (usd: number | null) => (usd === null ? "—" : usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const shortId = (id: string) => id.replace(/^[a-z]+:/, "").slice(0, 8);
const fit = (s: string, w: number) => truncate(s.replace(/[\r\n\t]+/g, " "), w).padEnd(w);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** First row of a window of `height` rows that keeps `sel` in view, roughly centred. */
export function windowStart(sel: number, total: number, height: number): number {
  return clamp(sel - Math.floor(height / 2), 0, Math.max(0, total - height));
}

function relPath(p: string, project: string | null): string {
  if (project && p.toLowerCase().startsWith(project.toLowerCase())) return p.slice(project.length).replace(/^[\\/]+/, "") || p;
  return p;
}

/** Where the data comes from, so tests can drive the UI without a database. */
export interface TuiData {
  sessions(): SessionRow[];
  events(sessionId: string): NormalizedEvent[];
}

function useSize(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const read = () => ({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout]);
  return size;
}

function Hints({ keys }: { keys: [string, string][] }) {
  return (
    <Text wrap="truncate">
      {keys.map(([k, what], i) => (
        <Text key={k}>
          {i > 0 && <Text color={COLOR.line}>{"  "}</Text>}
          <Text color={COLOR.fg}>{k}</Text>
          <Text color={COLOR.muted}> {what}</Text>
        </Text>
      ))}
    </Text>
  );
}

function Header({ right }: { right: string }) {
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text color={COLOR.brand}>▮</Text>
        <Text color={COLOR.fg} bold>
          {" "}afteraction
        </Text>
      </Text>
      <Text color={COLOR.muted} wrap="truncate">
        {right}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------- session list

function SessionList({ sessions, initial, onOpen }: { sessions: SessionRow[]; initial: number; onOpen: (s: SessionRow, index: number) => void }) {
  const { exit } = useApp();
  const { cols, rows } = useSize();
  const [sel, setSel] = useState(initial);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => [s.title, s.project_path ?? "", s.model ?? "", s.id].some((f) => f.toLowerCase().includes(q)));
  }, [sessions, query]);
  const cur = clamp(sel, 0, Math.max(0, shown.length - 1));
  const height = Math.max(1, rows - 6);

  useInput((input, key) => {
    if (searching) {
      if (key.return) setSearching(false);
      else if (key.escape) {
        setQuery("");
        setSearching(false);
      } else if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        setSel(0);
      }
      return;
    }
    const last = shown.length - 1;
    if (input === "q") exit();
    else if (input === "j" || key.downArrow) setSel(clamp(cur + 1, 0, last));
    else if (input === "k" || key.upArrow) setSel(clamp(cur - 1, 0, last));
    else if (input === "g") setSel(0);
    else if (input === "G") setSel(Math.max(0, last));
    else if (key.pageDown || (key.ctrl && input === "d")) setSel(clamp(cur + height, 0, last));
    else if (key.pageUp || (key.ctrl && input === "u")) setSel(clamp(cur - height, 0, last));
    else if (input === "/") setSearching(true);
    else if (key.escape && query) setQuery("");
    else if (input === "r") {
      const next = shown.findIndex((s, i) => i > cur && s.max_risk !== "none");
      if (next >= 0) setSel(next);
    } else if (key.return && shown[cur]) onOpen(shown[cur]!, sessions.indexOf(shown[cur]!));
  });

  const start = windowStart(cur, shown.length, height);
  const titleW = Math.max(10, cols - 2 - 3 - 16 - 2 - 18 - 2 - 6 - 2 - 6 - 2 - 7 - 2);
  const cost = sessions.reduce((a, s) => a + (s.est_cost_usd ?? 0), 0);

  return (
    <Box flexDirection="column" height={rows - 1} paddingX={1}>
      <Header right={`${sessions.length} sessions · ${fmtCost(cost)} est.`} />
      <Box marginTop={1}>
        <Text color={COLOR.muted} wrap="truncate">
          {"   " + fit("Started", 16) + "  " + fit("Project", 18) + "  " + "Time".padStart(6) + "  " + "Events".padStart(6) + "  " +
            "Cost".padStart(7) + "  Title"}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {shown.length === 0 && (
          <Text color={COLOR.muted}>{sessions.length ? `No sessions match "${query}".` : 'No sessions yet. Run "afteraction ingest", or try --demo.'}</Text>
        )}
        {shown.slice(start, start + height).map((s, i) => {
          const on = start + i === cur;
          return (
            <Text key={s.id} wrap="truncate" backgroundColor={on ? COLOR.raised : undefined}>
              <Text color={COLOR.accent}>{on ? "▌" : " "}</Text>
              <Text color={RISK_COLOR[s.max_risk]}>{s.max_risk === "none" ? "  " : "● "}</Text>
              <Text color={on ? COLOR.fg : COLOR.fg2}>{fit(fmtDateTime(s.started_at), 16)}  </Text>
              <Text color={COLOR.fg2}>{fit(baseName(s.project_path), 18)}  </Text>
              <Text color={COLOR.muted}>
                {fmtDuration(s.started_at, s.ended_at).padStart(6)}  {String(s.event_count).padStart(6)}  {fmtCost(s.est_cost_usd).padStart(7)}
                {"  "}
              </Text>
              <Text color={on ? COLOR.fg : COLOR.fg2}>{truncate(maskSecrets(s.title).replace(/\s+/g, " "), titleW)}</Text>
            </Text>
          );
        })}
      </Box>
      {searching || query ? (
        <Text wrap="truncate">
          <Text color={COLOR.accent}>/</Text>
          <Text color={COLOR.fg}>{query}</Text>
          {searching ? <Text color={COLOR.accent}>▏</Text> : <Text color={COLOR.muted}>{`  ${shown.length} matches · esc clears`}</Text>}
        </Text>
      ) : (
        <Text color={COLOR.muted} wrap="truncate">
          {`Cost: ${COST_LABEL.toLowerCase()} · ● highest risk in the session`}
        </Text>
      )}
      <Hints keys={[["j/k", "move"], ["enter", "open"], ["/", "search"], ["r", "next risky"], ["q", "quit"]]} />
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------- session view

interface Line {
  text: string;
  color?: string;
  italic?: boolean;
}

/** Hard-wraps text to `width` columns, keeping its own line breaks. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\t/g, "  ").split(/\r?\n/)) {
    if (raw.length <= width) out.push(raw);
    else for (let i = 0; i < raw.length; i += width) out.push(raw.slice(i, i + width));
  }
  return out;
}

/** The detail pane for one event as plain coloured lines, so it can scroll. */
export function detailLines(e: NormalizedEvent, opts: { width: number; reveal: boolean; project: string | null }): Line[] {
  const m = (t: string) => (opts.reveal ? t : maskSecrets(t));
  const w = Math.max(10, opts.width);
  const lines: Line[] = [];
  const add = (text: string, color?: string, italic?: boolean) => {
    for (const t of wrap(m(text), w)) lines.push({ text: t, color, italic });
  };
  const gap = () => lines.length && lines.at(-1)!.text !== "" && lines.push({ text: "" });
  const field = (label: string, value: string, color = COLOR.fg2) => value && add(`${label.padEnd(12)}${value}`, color);
  const block = (label: string, text: string, color = COLOR.fg) => {
    if (!text) return;
    gap();
    lines.push({ text: label, color: COLOR.muted });
    add(text, color);
  };
  const p = e.payload;
  const k = kindOf(e.kind);

  lines.push({
    text: `${k.label}  #${e.seq} · ${fmtDateTime(e.ts)}${p.subagent_id ? ` · subagent ${str(p.subagent_id).slice(0, 10)}` : ""}`,
    color: k.color,
  });
  for (const id of e.risk_rules) {
    const r = RULES.find((x) => x.id === id);
    add(`${(r?.severity ?? e.risk_level).toUpperCase()}  ${id}${r ? ` · ${r.description}` : ""}`, RISK_COLOR[r?.severity ?? e.risk_level]);
  }
  gap();

  switch (e.kind) {
    case "shell_command":
      block(`Command (${str(p.shell) || "shell"})`, str(p.command));
      gap();
      field("cwd", str(p.cwd));
      field(
        "exit code",
        typeof p.exit_code === "number" ? String(p.exit_code) : p.is_error === true ? "failed (code not recorded)" : p.is_error === false ? "succeeded (code not recorded)" : "—",
        p.is_error === true ? RISK_COLOR.high : COLOR.fg2,
      );
      if (typeof p.duration_ms === "number") field("duration", `${(p.duration_ms / 1000).toFixed(1)}s`);
      field("description", str(p.description));
      block("stdout", str(p.stdout_excerpt), COLOR.fg2);
      block("stderr", str(p.stderr_excerpt), RISK_COLOR.high);
      block("Error", str(p.error), RISK_COLOR.high);
      break;
    case "file_edit":
    case "file_write": {
      field("file", relPath(str(p.path), opts.project));
      field("lines", `+${Number(p.lines_added ?? 0)} −${Number(p.lines_removed ?? 0)}${p.operation ? ` · ${str(p.operation)}` : ""}`);
      const diff = str(p.unified_diff);
      const added = e.kind === "file_write" && !diff ? str(p.content_excerpt) : "";
      gap();
      if (diff) {
        for (const l of diff.split(/\r?\n/)) {
          if (/^(---|\+\+\+) /.test(l)) continue;
          add(l, l.startsWith("+") ? COLOR.ok : l.startsWith("-") ? RISK_COLOR.high : l.startsWith("@@") ? RISK_COLOR.low : COLOR.fg2);
        }
      } else if (added) {
        for (const l of added.split(/\r?\n/)) add(`+${l}`, COLOR.ok);
      } else {
        block("Old", str(p.old_excerpt), RISK_COLOR.high);
        block("New", str(p.new_excerpt), COLOR.ok);
      }
      block("Error", str(p.error), RISK_COLOR.high);
      break;
    }
    case "file_read":
      field("file", relPath(str(p.path), opts.project));
      block("Error", str(p.error), RISK_COLOR.high);
      break;
    case "web_fetch":
      field("url", str(p.url));
      block("Result", str(p.result_excerpt), COLOR.fg2);
      break;
    case "user_message":
    case "assistant_message":
      add(str(p.text) || (p.images ? `(${String(p.images)} image${p.images === 1 ? "" : "s"})` : ""), COLOR.fg);
      if (p.meta) {
        gap();
        add("Injected by the CLI (command output, reminder or notification), not typed by a person.", COLOR.muted);
      }
      break;
    case "thinking":
      if (p.redacted) add("The log only keeps a signature for this thinking block; the text was not recorded.", COLOR.muted);
      else add(str(p.text), COLOR.muted, true);
      break;
    case "subagent_start":
    case "subagent_end":
      field("description", str(p.description));
      field("type", str(p.subagent_type) || str(p.agent_type));
      field("status", str(p.status));
      field("agent id", str(p.agent_id));
      block("Prompt", str(p.prompt_excerpt), COLOR.fg2);
      break;
    case "error":
      add(str(p.message), RISK_COLOR.high);
      break;
    default:
      field("tool", str(p.tool_name) || e.kind);
      if (p.input !== undefined) block("Input", JSON.stringify(p.input, null, 2), COLOR.fg2);
      block("Result", str(p.result_excerpt) || str(p.content_excerpt), COLOR.fg2);
      block("Error", str(p.error), RISK_COLOR.high);
      field("reason", str(p.reason));
  }

  if (e.tokens_in !== null) {
    gap();
    add(
      `tokens ${fmtTokens(e.tokens_in)} in · ${fmtTokens(e.tokens_out ?? 0)} out · ${fmtTokens(e.cache_read ?? 0)} cache read · ` +
        `${fmtTokens(e.cache_write ?? 0)} cache write · ${fmtCost(e.est_cost_usd ?? null)}${e.model ? ` · ${e.model}` : ""}`,
      COLOR.muted,
    );
  }
  return lines;
}

/** One character per bucket of events: risks in their colour, prompts taller, the current position in the accent. */
function Tape({ events, sel, width }: { events: NormalizedEvent[]; sel: number; width: number }) {
  const n = events.length;
  const buckets = Math.max(1, Math.min(n, width));
  const segs: { text: string; color: string }[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * n) / buckets);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / buckets));
    const slice = events.slice(from, to);
    const risk = slice.reduce<RiskLevel>((a, e) => (riskRank(e.risk_level) > riskRank(a) ? e.risk_level : a), "none");
    let ch = "▁";
    let color = COLOR.line;
    if (slice.some((e) => e.kind === "user_message")) [ch, color] = ["▄", COLOR.fg2];
    if (risk !== "none") [ch, color] = ["█", RISK_COLOR[risk]];
    if (sel >= from && sel < to) [ch, color] = ["█", COLOR.accent];
    const last = segs.at(-1);
    if (last && last.color === color) last.text += ch;
    else segs.push({ text: ch, color });
  }
  return (
    <Text wrap="truncate">
      {segs.map((s, i) => (
        <Text key={i} color={s.color}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

function SessionView({ session, all, onBack }: { session: SessionRow; all: NormalizedEvent[]; onBack: () => void }) {
  const { exit } = useApp();
  const { cols, rows } = useSize();
  const [showThinking, setShowThinking] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [focus, setFocus] = useState<"timeline" | "detail">("timeline");
  const [selId, setSelId] = useState<string | undefined>(all[0]?.id);
  const [scroll, setScroll] = useState(0);

  const events = useMemo(
    () => all.filter((e) => (showThinking || e.kind !== "thinking") && (showMeta || !(e.kind === "user_message" && e.payload.meta === true))),
    [all, showThinking, showMeta],
  );
  // Keep the selected event when filters change; fall back to the nearest earlier one.
  const sel = useMemo(() => {
    const i = events.findIndex((e) => e.id === selId);
    if (i >= 0) return i;
    const seq = all.find((e) => e.id === selId)?.seq ?? 0;
    let j = events.length - 1;
    while (j > 0 && events[j]!.seq > seq) j--;
    return Math.max(0, j);
  }, [events, all, selId]);
  const event = events[sel];

  const inner = cols - 2;
  const avail = Math.max(6, rows - 1 - 6);
  const listH = Math.max(3, Math.floor(avail * 0.45));
  const detailH = Math.max(2, avail - listH);
  const lines = useMemo(
    () => (event ? detailLines(event, { width: inner, reveal, project: session.project_path }) : []),
    [event, inner, reveal, session.project_path],
  );
  const maxScroll = Math.max(0, lines.length - detailH);

  const select = (i: number) => {
    const e = events[clamp(i, 0, events.length - 1)];
    if (e) setSelId(e.id);
    setScroll(0);
  };
  const jumpRisk = (dir: 1 | -1) => {
    for (let i = sel + dir; i >= 0 && i < events.length; i += dir) {
      if (events[i]!.risk_level !== "none") return select(i);
    }
  };

  useInput((input, key) => {
    if (input === "q") return exit();
    if (input === "t") return setShowThinking((v) => !v);
    if (input === "i") return setShowMeta((v) => !v);
    if (input === "s") return setReveal((v) => !v);
    if (input === "r") return jumpRisk(1);
    if (input === "R") return jumpRisk(-1);
    if (key.tab) return setFocus((f) => (f === "timeline" ? "detail" : "timeline"));
    if (focus === "detail") {
      if (key.escape || key.leftArrow) setFocus("timeline");
      else if (input === "j" || key.downArrow) setScroll((s) => clamp(s + 1, 0, maxScroll));
      else if (input === "k" || key.upArrow) setScroll((s) => clamp(s - 1, 0, maxScroll));
      else if (input === " " || key.pageDown || (key.ctrl && input === "d")) setScroll((s) => clamp(s + detailH - 1, 0, maxScroll));
      else if (key.pageUp || (key.ctrl && input === "u")) setScroll((s) => clamp(s - detailH + 1, 0, maxScroll));
      else if (input === "g") setScroll(0);
      else if (input === "G") setScroll(maxScroll);
      return;
    }
    if (key.escape || key.backspace || key.leftArrow) onBack();
    else if (input === "j" || key.downArrow) select(sel + 1);
    else if (input === "k" || key.upArrow) select(sel - 1);
    else if (input === "g") select(0);
    else if (input === "G") select(events.length - 1);
    else if (key.pageDown || (key.ctrl && input === "d")) select(sel + listH);
    else if (key.pageUp || (key.ctrl && input === "u")) select(sel - listH);
    else if (key.return || key.rightArrow) setFocus("detail");
  });

  const flagged = all.filter((e) => e.risk_level !== "none").length;
  const tokens = session.total_input_tokens + session.total_output_tokens + session.total_cache_read_tokens + session.total_cache_write_tokens;
  const start = windowStart(sel, events.length, listH);
  const hidden = all.length - events.length;

  return (
    <Box flexDirection="column" height={rows - 1} paddingX={1}>
      <Header right={`${AGENT_LABEL[session.source] ?? session.source} · ${session.model ?? "unknown model"} · ${shortId(session.id)}`} />
      <Text color={COLOR.fg} bold wrap="truncate">
        {maskSecrets(session.title).replace(/\s+/g, " ")}
      </Text>
      <Text wrap="truncate">
        <Text color={COLOR.fg2}>{baseName(session.project_path)}</Text>
        <Text color={COLOR.muted}>
          {"  "}
          {all.length} events{hidden ? ` (${hidden} hidden)` : ""}
          {" · "}
          {fmtDateTime(session.started_at)} · {fmtDuration(session.started_at, session.ended_at)} · {fmtTokens(tokens)} tokens · {fmtCost(session.est_cost_usd)} est.
          {" · "}
        </Text>
        <Text color={flagged ? RISK_COLOR[session.max_risk] : COLOR.muted}>{flagged ? `${flagged} flagged` : "no risks"}</Text>
              </Text>
      <Tape events={events} sel={sel} width={inner} />
      <Box flexDirection="column" height={listH}>
        {events.length === 0 && <Text color={COLOR.muted}>No events to show. Press t or i to include thinking or injected messages.</Text>}
        {events.slice(start, start + listH).map((e, i) => {
          const on = start + i === sel;
          const k = kindOf(e.kind);
          const nested = e.payload.subagent_id && e.kind !== "subagent_end" ? "↳ " : "";
          const failed = e.payload.is_error === true ? " ✗" : "";
          const badge = e.risk_level !== "none" ? ` ${e.risk_level}` : "";
          const sumW = Math.max(5, inner - 1 - 5 - 10 - 11 - nested.length - failed.length - badge.length);
          const summary = truncate((reveal ? e.summary : maskSecrets(e.summary)).replace(/\s+/g, " "), sumW);
          return (
            <Text key={e.id} wrap="truncate" backgroundColor={on ? COLOR.raised : undefined}>
              <Text color={focus === "timeline" ? COLOR.accent : COLOR.muted}>{on ? "▌" : " "}</Text>
              <Text color={COLOR.muted}>
                {String(e.seq).padStart(4)} {fmtTime(e.ts)}{"  "}
              </Text>
              <Text color={k.color}>{fit(k.label, 10)} </Text>
              <Text color={on ? COLOR.fg : COLOR.fg2}>
                {nested}
                {summary}
              </Text>
              <Text color={RISK_COLOR.high}>{failed}</Text>
              <Text>{" ".repeat(Math.max(0, sumW - summary.length))}</Text>
              <Text color={RISK_COLOR[e.risk_level]} bold>
                {badge}
              </Text>
            </Text>
          );
        })}
      </Box>
      <Text color={focus === "detail" ? COLOR.accent : COLOR.line} wrap="truncate">
        {"─".repeat(inner)}
      </Text>
      <Box flexDirection="column" height={detailH}>
        {lines.slice(scroll, scroll + detailH).map((l, i) => (
          <Text key={scroll + i} color={l.color} italic={l.italic} wrap="truncate">
            {l.text || " "}
          </Text>
        ))}
      </Box>
      <Hints
        keys={
          focus === "detail"
            ? [["j/k", "scroll"], ["space", "page"], ["tab", "timeline"], ["s", reveal ? "mask secrets" : "reveal secrets"], ["q", "quit"]]
            : [
                ["j/k", "move"],
                ["r/R", "next/prev risk"],
                ["enter", "detail"],
                ["t", showThinking ? "hide thinking" : "thinking"],
                ["i", showMeta ? "hide injected" : "injected"],
                ["s", reveal ? "mask" : "reveal"],
                ["esc", "back"],
                ["q", "quit"],
              ]
        }
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------- app

export function App({ data, initialSessionId }: { data: TuiData; initialSessionId?: string }) {
  // Log text goes straight to the terminal, so escape sequences in it are neutralised first.
  const sessions = useMemo(() => safeTerminalDeep(data.sessions()), [data]);
  const [open, setOpen] = useState<{ session: SessionRow; index: number } | null>(() => {
    const i = sessions.findIndex((s) => s.id === initialSessionId);
    return i >= 0 ? { session: sessions[i]!, index: i } : null;
  });
  const [listSel, setListSel] = useState(open?.index ?? 0);
  const events = useMemo(() => (open ? safeTerminalDeep(data.events(open.session.id)) : []), [data, open]);

  if (open) {
    return (
      <SessionView
        key={open.session.id}
        session={open.session}
        all={events}
        onBack={() => {
          setListSel(open.index);
          setOpen(null);
        }}
      />
    );
  }
  return <SessionList sessions={sessions} initial={listSel} onOpen={(session, index) => setOpen({ session, index })} />;
}

/** Runs the browser on the terminal's alternate screen until the user quits. */
export async function runTui(data: TuiData, opts: { initialSessionId?: string } = {}): Promise<void> {
  const out = process.stdout;
  out.write("\x1b[?1049h\x1b[H");
  try {
    const app = render(<App data={data} initialSessionId={opts.initialSessionId} />, { exitOnCtrlC: true });
    await app.waitUntilExit();
  } finally {
    out.write("\x1b[?1049l");
  }
}
