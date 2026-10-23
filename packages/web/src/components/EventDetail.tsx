import { useEffect, useState, type ReactNode } from "react";
import { api, type NormalizedEvent } from "../api";
import { useMeta } from "../App";
import { fmtCost, fmtDateTime, fmtTokens, relPath, str } from "../format";
import { asAddedDiff, Diff } from "./Diff";
import { Button, RiskBadge } from "./ui";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-xs">
      <div className="w-24 shrink-0 text-muted">{label}</div>
      <div className="min-w-0 break-all">{children}</div>
    </div>
  );
}

function Block({ label, text, tone }: { label: string; text: string; tone?: "error" }) {
  if (!text) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <pre
        className={`max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded border p-2 text-xs leading-5 ${
          tone === "error" ? "border-red-500/40 bg-red-500/5" : "border-line bg-bg"
        }`}
      >
        {text}
      </pre>
    </div>
  );
}

export function EventDetail({ event: initial, projectPath }: { event: NormalizedEvent; projectPath: string | null }) {
  const meta = useMeta();
  const [event, setEvent] = useState(initial);
  const [revealed, setRevealed] = useState(false);
  const [raw, setRaw] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEvent(initial);
    setRevealed(false);
    setRaw(null);
  }, [initial]);

  const masked = JSON.stringify(event.payload).includes("…[redacted]") || event.summary.includes("…[redacted]");
  const load = async (opts: { reveal?: boolean; raw?: boolean }) => {
    setBusy(true);
    try {
      const { event: e } = await api.event(event.id, { reveal: opts.reveal ?? revealed, raw: opts.raw });
      if (opts.reveal) {
        setEvent(e);
        setRevealed(true);
      }
      if (opts.raw) setRaw(e.raw);
    } finally {
      setBusy(false);
    }
  };

  const p = event.payload;
  const path = str(p.path);
  const rules = meta?.rules ?? [];
  const body: ReactNode[] = [];

  switch (event.kind) {
    case "shell_command":
      body.push(
        <Block key="cmd" label={`Command (${str(p.shell) || "shell"})`} text={str(p.command)} />,
        <div key="f" className="space-y-1">
          {p.cwd !== undefined && <Field label="cwd">{str(p.cwd)}</Field>}
          <Field label="exit code">
            {typeof p.exit_code === "number" ? p.exit_code : p.is_error === true ? "failed (code not recorded)" : p.is_error === false ? "succeeded (code not recorded)" : "—"}
          </Field>
          {typeof p.duration_ms === "number" && <Field label="duration">{(p.duration_ms / 1000).toFixed(1)}s</Field>}
          {p.description !== undefined && <Field label="description">{str(p.description)}</Field>}
        </div>,
        <Block key="out" label="stdout" text={str(p.stdout_excerpt)} />,
        <Block key="err" label="stderr" text={str(p.stderr_excerpt)} />,
        <Block key="e" label="Error" text={str(p.error)} tone="error" />,
      );
      break;
    case "file_edit":
    case "file_write": {
      const diff = str(p.unified_diff) || (event.kind === "file_write" && p.content_excerpt ? asAddedDiff(str(p.content_excerpt)) : "");
      body.push(
        <div key="f" className="space-y-1">
          <Field label="file">{relPath(path, projectPath)}</Field>
          <Field label="lines">
            <span className="text-emerald-600 dark:text-emerald-400">+{Number(p.lines_added ?? 0)}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{Number(p.lines_removed ?? 0)}</span>
            {p.operation ? ` · ${str(p.operation)}` : ""}
          </Field>
        </div>,
        diff ? (
          <Diff key="d" text={diff} />
        ) : (
          <div key="d" className="space-y-2">
            <Block label="Old" text={str(p.old_excerpt)} />
            <Block label="New" text={str(p.new_excerpt)} />
          </div>
        ),
        <Block key="e" label="Error" text={str(p.error)} tone="error" />,
      );
      break;
    }
    case "file_read":
      body.push(
        <Field key="f" label="file">{relPath(path, projectPath)}</Field>,
        <Block key="e" label="Error" text={str(p.error)} tone="error" />,
      );
      break;
    case "web_fetch":
      body.push(<Field key="u" label="url">{str(p.url)}</Field>, <Block key="r" label="Result" text={str(p.result_excerpt)} />);
      break;
    case "user_message":
    case "assistant_message":
      body.push(
        <pre key="t" className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed">
          {str(p.text) || (p.images ? `(${String(p.images)} image${p.images === 1 ? "" : "s"})` : "")}
        </pre>,
      );
      if (p.meta) body.push(<div key="m" className="text-xs text-muted">Injected by the CLI (command output, reminder or notification), not typed by a person.</div>);
      break;
    case "thinking":
      body.push(
        p.redacted ? (
          <div key="t" className="text-muted">The log only keeps a signature for this thinking block; the text was not recorded.</div>
        ) : (
          <pre key="t" className="whitespace-pre-wrap break-words font-sans text-[13px] italic leading-relaxed text-muted">{str(p.text)}</pre>
        ),
      );
      break;
    case "subagent_start":
    case "subagent_end":
      body.push(
        <div key="f" className="space-y-1">
          <Field label="description">{str(p.description)}</Field>
          {p.subagent_type !== undefined && <Field label="type">{str(p.subagent_type)}</Field>}
          {p.agent_type !== undefined && <Field label="type">{str(p.agent_type)}</Field>}
          {p.status !== undefined && <Field label="status">{str(p.status)}</Field>}
          {p.agent_id !== undefined && <Field label="agent id">{str(p.agent_id)}</Field>}
        </div>,
        <Block key="p" label="Prompt" text={str(p.prompt_excerpt)} />,
      );
      break;
    case "error":
      body.push(<Block key="e" label="Error" text={str(p.message)} tone="error" />);
      break;
    default:
      body.push(
        <Field key="n" label="tool">{str(p.tool_name) || event.kind}</Field>,
        p.input !== undefined ? <Block key="i" label="Input" text={JSON.stringify(p.input, null, 2)} /> : null,
        <Block key="r" label="Result" text={str(p.result_excerpt) || str(p.content_excerpt)} />,
        <Block key="e" label="Error" text={str(p.error)} tone="error" />,
        p.reason !== undefined ? <Field key="why" label="reason">{str(p.reason)}</Field> : null,
      );
  }

  const tokens = event.tokens_in !== null;

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px]">{event.kind}</span>
        <span className="text-xs text-muted">#{event.seq} · {fmtDateTime(event.ts)}</span>
        {event.payload.subagent_id ? <span className="text-xs text-muted">· subagent {str(event.payload.subagent_id)}</span> : null}
        <div className="ml-auto flex gap-2">
          {masked && !revealed && (
            <Button onClick={() => void load({ reveal: true })} disabled={busy} title="Secrets are masked by default">
              Reveal secrets
            </Button>
          )}
          <Button onClick={() => (raw ? setRaw(null) : void load({ raw: true }))} disabled={busy} active={!!raw}>
            Raw JSON
          </Button>
        </div>
      </div>

      {event.risk_rules.length > 0 && (
        <div className="space-y-1 rounded border border-red-500/30 bg-red-500/5 p-2">
          {event.risk_rules.map((id) => {
            const r = rules.find((x) => x.id === id);
            return (
              <div key={id} className="flex items-center gap-2 text-xs">
                <RiskBadge level={r?.severity ?? event.risk_level} />
                <span className="font-mono">{id}</span>
                <span className="text-muted">{r?.description}</span>
              </div>
            );
          })}
        </div>
      )}

      {body}

      {tokens && (
        <div className="space-y-1 border-t border-line pt-3">
          <Field label="model">{event.model ?? "—"}</Field>
          <Field label="tokens">
            {fmtTokens(event.tokens_in)} in · {fmtTokens(event.tokens_out)} out · {fmtTokens(event.cache_read)} cache read ·{" "}
            {fmtTokens(event.cache_write)} cache write
          </Field>
          <Field label="est. cost">
            {fmtCost(event.est_cost_usd ?? null)} <span className="text-muted">(estimated, API-equivalent, whole API call)</span>
          </Field>
        </div>
      )}

      {raw !== null && <Block label="Raw log JSON" text={JSON.stringify(raw, null, 2)} />}
    </div>
  );
}
