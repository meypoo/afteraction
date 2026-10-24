import { describe, expect, it } from "vitest";
import { buildReceipt, code, maskSecrets, redactText } from "../src/receipt.js";
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
    expect(md).toContain("**Agent:** Claude Code · **Model:** `claude-opus-5-5` · **Duration:** 42m · **Est. cost:** $3.18 (estimated, API-equivalent)");
    expect(md).toContain("**Prompt:** `Add Stripe webhook handler`");
    expect(md).toContain("<sub>Generated locally by flightrec v0.1.0 — transcript not uploaded.</sub>");
  });

  it("lists changed files relative to the project with line counts", () => {
    expect(md).toContain("**Files changed (1):** `src/api/webhook.ts` (+123/−4)");
  });

  it("groups commands with counts in first-seen order", () => {
    expect(md).toMatch(/\*\*Commands run \(5\):\*\* `npm i stripe`, `npm test` ×2, ``git commit -m "add `webhook`"``, `echo sk-ant…\[redacted\]`$/m);
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

  it("labels every agent", () => {
    for (const [source, label] of [["opencode", "OpenCode"], ["antigravity", "Antigravity"], ["gemini_cli", "Gemini CLI"]] as const) {
      expect(buildReceipt({ ...session, source }, [], { version: "0.1.0", homeDir: HOME })).toContain(`**Agent:** ${label} ·`);
    }
  });
});

describe("receipt Markdown injection", () => {
  const evil = [
    "[click](https://attacker.example) @maintainer ![x](https://attacker.example/p.png) <img src=x>",
    "line one\n# Heading\n@everyone\r\n- item",
    "a ``` b `` c `",
    "`starts and ends`",
  ];
  for (const text of evil) {
    it(`keeps ${JSON.stringify(text.slice(0, 16))} inside one code span everywhere`, () => {
      const md = buildReceipt(
        { ...session, title: text, model: text },
        [
          ev("shell_command", { command: text }, ["high", ["git-force"]]),
          ev("file_write", { path: `${PROJECT}\\${text}`, lines_added: 1, lines_removed: 0 }, ["medium", ["outside-project-write"]]),
          { ...ev("web_fetch", { url: text }, ["medium", ["network-exfil-hint"]]), summary: text },
        ],
        { version: "0.1.0", homeDir: HOME },
      );
      // Untrusted newlines never reach the output, so nothing can start a heading, list or mention line.
      const lines = md.split("\n");
      expect(lines.filter((l) => /^(#|@|- item)/.test(l))).toEqual(["### 🛫 Agent session receipt"]);
      // Each copy is fenced by a backtick run longer than any inside it, so it cannot close early.
      const flat = code(text);
      const fence = /^`+/.exec(flat)![0];
      expect(flat.endsWith(fence)).toBe(true);
      expect(flat.slice(fence.length, -fence.length)).not.toContain(fence);
      expect(md).toContain(`**Prompt:** ${flat}`);
      expect(md).toContain(`**Model:** ${flat}`);
    });
  }
});

describe("maskSecrets", () => {
  it("masks prefixed tokens and credentials recognised by context", () => {
    const cases: [string, string][] = [
      ["github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP", "github_pat_…[redacted]"],
      ["glpat-abcdefghij0123456789", "glpat-…[redacted]"],
      ["xoxb-1234567890-abcdefghij", "xoxb-…[redacted]"],
      ["AIzaSyA-abcdefghijklmnopqrstuvwxyz01234", "AIza…[redacted]"],
      ["OPENAI_API_KEY=hunter2hunter2", "OPENAI_API_KEY=…[redacted]"],
      ['export DB_PASSWORD="correct-horse"', 'export DB_PASSWORD="…[redacted]"'],
      ['{"password": "s3cr3t-value"}', '{"password": "…[redacted]"}'],
      ["curl -H 'Authorization: Bearer abc.def.ghijkl'", "curl -H 'Authorization: Bearer …[redacted]'"],
      ["git clone https://bob:pa55word@git.example/x", "git clone https://bob:…[redacted]@git.example/x"],
      ["mysql --password=letmein123", "mysql --password=…[redacted]"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY-----…[redacted]"],
    ];
    for (const [input, want] of cases) expect(maskSecrets(input), input).toBe(want);
  });

  it("leaves ordinary code and variable references alone", () => {
    for (const s of ["const token = getToken();", "MAX_TOKENS=100000", "GITHUB_TOKEN=$GITHUB_TOKEN", "max_tokens: 4096", "--token-file x"]) {
      expect(maskSecrets(s)).toBe(s);
    }
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
