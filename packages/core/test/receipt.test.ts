import { describe, expect, it } from "vitest";
import { buildReceipt, redactText } from "../src/receipt.js";
import type { EventKind, NormalizedEvent, RiskLevel } from "../src/model.js";
import type { SessionRow } from "../src/db.js";

const HOME = "C:\\Users\\alice";
const PROJECT = `${HOME}\\projects\\shop`;

let seq = 0;
function ev(kind: EventKind, payload: Record<string, unknown>, risk: [RiskLevel, string[]] = ["none", []]): NormalizedEvent {
  return {
    id: `s:${seq}`, session_id: "s", seq: seq++, ts: null, kind, summary: "", payload, raw: null,
    tokens_in: null, tokens_out: null, cache_read: null, cache_write: null, usage_extra: null, model: null,
    risk_level: risk[0], risk_rules: risk[1],
  };
}

const session = {
  id: "claude:abc", source: "claude_code", project_path: PROJECT, git_branch: "main",
  started_at: "2026-01-15T10:00:00Z", ended_at: "2026-01-15T10:42:10Z", model: "claude-opus-5-5",
  title: "Add Stripe webhook handler", total_input_tokens: 0, total_output_tokens: 0, total_cache_read_tokens: 0,
  total_cache_write_tokens: 0, est_cost_usd: 3.184, max_risk: "high", source_file: "x", source_hash: "y", event_count: 0,
  unpriced_models: "[]",
} satisfies SessionRow;

const events = [
  ev("user_message", { text: "Add Stripe webhook handler" }),
  ev("file_read", { path: `${PROJECT}\\.env.local` }, ["high", ["secret-file-read"]]),
  ev("shell_command", { command: "npm i stripe" }, ["low", ["package-install"]]),
  ev("file_write", { path: `${PROJECT}\\src\\api\\webhook.ts`, lines_added: 120, lines_removed: 0, is_error: false }),
  ev("file_edit", { path: `${PROJECT}\\src\\api\\webhook.ts`, lines_added: 3, lines_removed: 4, is_error: false }),
  ev("file_edit", { path: `${PROJECT}\\src\\app.ts`, lines_added: 1, lines_removed: 1, is_error: true }), // failed: not a change
  ev("file_write", { path: `${HOME}\\AppData\\Local\\Temp\\scratch\\edit.py`, lines_added: 9, is_error: false }), // scratch: left out
  ev("file_write", { path: `${HOME}\\.claude\\projects\\x\\memory\\notes.md`, lines_added: 2, is_error: false }), // agent memory: left out
  ev("shell_command", { command: "npm test" }),
  ev("shell_command", { command: "npm test" }),
  ev("shell_command", { command: 'git commit -m "add `webhook`"' }),
  ev("shell_command", { command: "echo sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345", stdout_excerpt: "" }, ["none", []]),
];

describe("buildReceipt", () => {
  const md = buildReceipt(session, events, { version: "0.1.0", homeDir: HOME });

  it("follows the spec layout with labelled estimated cost", () => {
    expect(md).toContain("### 🛫 Agent session receipt");
    expect(md).toContain("**Agent:** Claude Code · **Model:** claude-opus-5-5 · **Duration:** 42m · **Est. cost:** $3.18 (estimated, API-equivalent)");
    expect(md).toContain('**Prompt:** "Add Stripe webhook handler"');
    expect(md).toContain("<sub>Generated locally by flightrec v0.1.0 — transcript not uploaded.</sub>");
  });

  it("lists changed files relative to the project with line counts", () => {
    expect(md).toContain("**Files changed (1):** src/api/webhook.ts (+123/−4)");
  });

  it("groups commands with counts in first-seen order", () => {
    expect(md).toMatch(/\*\*Commands run \(5\):\*\* npm i stripe, npm test ×2, ``git commit -m "add `webhook`"``, echo sk-ant…\[redacted\]$/m);
  });

  it("lists risk flags worst first", () => {
    expect(md).toContain("**⚠️ Risk flags (2):**\n- high · secret-file-read · read `.env.local`\n- low · package-install · `npm i stripe`");
  });

  it("redacts secrets and home paths by default, not when asked", () => {
    expect(md).not.toContain("abcdefghijklmnop");
    expect(md).not.toContain("alice");
    const raw = buildReceipt({ ...session, project_path: null }, events, { version: "0.1.0", homeDir: HOME, redact: false });
    expect(raw).toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345");
    expect(raw).toContain("C:\\Users\\alice\\projects\\shop\\src\\api\\webhook.ts");
  });

  it("shows — for unknown cost and says when there are no risks", () => {
    const md2 = buildReceipt({ ...session, est_cost_usd: null }, [events[0]!], { version: "0.1.0", homeDir: HOME });
    expect(md2).toContain("**Est. cost:** — (unknown model pricing)");
    expect(md2).toContain("**Risk flags:** none");
    expect(md2).toContain("**Files changed:** none");
    expect(md2).toContain("**Commands run:** none");
  });
});

describe("redactText", () => {
  it("masks key patterns and home directories in any OS form", () => {
    expect(redactText("key=AKIAIOSFODNN7EXAMPLE", "/home/bob")).toBe("key=AKIA…[redacted]");
    expect(redactText("cd /home/bob/x && ls C:\\Users\\bob\\y", "/home/bob")).toBe("cd ~/x && ls ~\\y");
    expect(redactText("open /Users/carol/notes", "/home/bob")).toBe("open ~/notes");
    expect(redactText('cat "C:/Users/bob/.claude/x"', "/home/bob")).toBe('cat "~/.claude/x"');
    expect(redactText("cd /c/Users/bob/app", "/home/bob")).toBe("cd ~/app");
  });
});
