# Afteraction — Product & Technical Spec (v0.1 MVP)

> Working name: **Afteraction** (`afteraction` CLI). Rename freely.
> One-liner: *See exactly what your coding agent did — every command, file, risk and dollar — replayed locally.*

---

## 1. Problem

Developers increasingly let AI coding agents (Claude Code, OpenAI Codex CLI, Cursor, OpenCode, Gemini CLI) run for long stretches. Afterwards they can't easily answer:

- What commands did it run? Did it touch anything dangerous?
- Which files did it read (including secrets like `.env`) and change?
- How much did that session cost, and which task burned the tokens?
- How can a reviewer see *how* a PR was produced, not just the diff?

The agents already write detailed logs to disk, but in raw JSONL formats nobody reads. Existing tools cover slices only: ccusage (cost only), transcript exporters (static HTML, single agent), LLM-observability platforms like Langfuse/LangSmith (built for apps using LLM SDKs, not local coding-agent history).

## 2. Goals / Non-goals

**Goals (MVP)**
1. Read local session logs from **Claude Code** and **Codex CLI** with zero configuration.
2. Normalize them into one common event model stored in local SQLite.
3. Local web UI: session list, timeline replay, file diffs, risk flags, cost.
4. Rule-based risk detection with severity levels.
5. Export a "session receipt" (Markdown) suitable for a PR comment.
6. One-command run: `npx afteraction` opens the UI in the browser.
7. 100% local. No telemetry, no network calls except optional price-table refresh (off by default).

**Non-goals (MVP)**
- Controlling, orchestrating, or letting agents talk to each other.
- Real-time interception or blocking of agent actions (v2 idea).
- Cloud sync, accounts, teams.
- LLM-powered analysis (v2, optional, bring-your-own-key).

## 3. Target users
- Solo developers who vibe-code with agents and want to audit/understand sessions.
- Reviewers of agent-written PRs.
- Cost-conscious users on API billing or plan limits.

## 4. Supported sources (MVP)

| Agent | Default log location (verify on real machine) | Format |
|---|---|---|
| Claude Code | `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl` | JSONL, one message/event per line |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL |

Rules:
- Locations are **auto-discovered** and overridable via `--source claude=<path>` or config file.
- Parsers must be **tolerant**: unknown event types are kept as `unknown` events, never crash ingestion. Log a warning with file + line number.
- Each adapter declares the format versions it has been tested against.
- Later adapters (v0.2+): Cursor, OpenCode, Gemini CLI, Aider.

## 5. Normalized data model

```
Session
  id            string   (source-prefixed, e.g. "claude:<uuid>")
  source        enum     claude_code | codex | ...
  project_path  string?  working directory
  git_branch    string?
  started_at    datetime
  ended_at      datetime
  model         string?  (primary model; per-event model also stored)
  title         string   (first user prompt, truncated to 120 chars)
  total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_write_tokens  int
  est_cost_usd  float
  max_risk      enum     none | low | medium | high | critical
  source_file   string   original log path
  source_hash   string   for incremental re-ingest

Event
  id, session_id, seq (int, order within session), ts
  kind  enum:
    user_message | assistant_message | thinking |
    tool_call | tool_result |
    shell_command | file_read | file_write | file_edit |
    web_fetch | subagent_start | subagent_end | error | unknown
  summary   string   (one-line human description)
  payload   JSON     (normalized fields, see below)
  raw       JSON     (original line, for debugging/export)
  tokens_in, tokens_out, cache_read, cache_write  int?
  model     string?
  risk_level enum, risk_rules string[]

Payload by kind:
  shell_command: { command, cwd?, exit_code?, stdout_excerpt?, stderr_excerpt?, duration_ms? }
  file_read:     { path }
  file_write:    { path, content_excerpt?, bytes? }
  file_edit:     { path, old_excerpt?, new_excerpt?, unified_diff? }
  web_fetch:     { url }
  tool_call:     { tool_name, input }  (fallback for tools not mapped above, incl. MCP tools)

FileTouch (derived view)
  session_id, path, reads, writes, edits, first_ts, last_ts
```

Excerpts are capped (default 4 KB) to keep the DB small; full raw is retained in `raw`.

## 6. Risk rules (MVP)

Rules are pure functions over events, defined in one file, each with: `id`, `severity`, `description`, `match(event) -> boolean`, and tests.

| ID | Severity | Matches |
|---|---|---|
| `destructive-rm` | high | `rm -rf` / `rm -fr` on paths outside obvious build dirs (`node_modules`, `dist`, `build`, `.next`, `target`) |
| `rm-root-or-home` | critical | `rm -rf /`, `~`, `$HOME`, `*` at repo root |
| `pipe-to-shell` | high | `curl … \| sh`, `wget … \| bash`, etc. |
| `git-force` | high | `git push --force`/`-f`, `git reset --hard`, `git clean -fdx` |
| `git-history-rewrite` | medium | `git rebase`, `git filter-branch`, `commit --amend` on pushed branch (best-effort) |
| `secret-file-read` | high | reads of `.env*`, `*.pem`, `id_rsa*`, `.npmrc`, `.aws/credentials`, `*.key` |
| `secret-in-output` | high | regex hits for API key patterns (AWS, OpenAI `sk-`, Anthropic `sk-ant-`, GitHub `ghp_`, Stripe `sk_live_`) in written files or command output |
| `sudo` | medium | any `sudo` command |
| `package-install` | low | `npm i`, `pip install`, `brew install`, `cargo add` (supply-chain awareness) |
| `outside-project-write` | medium | writes/edits to paths outside `project_path` |
| `network-exfil-hint` | medium | `curl`/`wget` with `-d`/`--data`/`-F` to non-localhost |
| `chmod-permissive` | low | `chmod 777`, `chmod -R` |
| `db-destructive` | high | `DROP TABLE`, `TRUNCATE`, `DELETE FROM` without `WHERE` in commands or SQL files |

Session `max_risk` = highest event severity. False positives are acceptable at `low`; every `high`/`critical` rule needs positive **and** negative test cases.

## 7. Cost estimation
- Prices stored in `prices.json` (per model: input, output, cache read, cache write per 1M tokens), versioned in repo with a `last_updated` date shown in the UI.
- Unknown model → cost shown as "—" with a tooltip, never guessed.
- Label everywhere: **"Estimated, API-equivalent pricing"** (subscription users don't pay per token).
- Cost per session, per day, per project; top 10 most expensive sessions.

## 8. CLI

```
afteraction                  # ingest (incremental) then open UI at http://localhost:4317
afteraction ingest [--full]  # ingest only
afteraction list [--since 7d] [--project <path>] [--risk high]
afteraction show <session-id>            # terminal timeline
afteraction tui [session-id]             # full-screen terminal browser (Ink): session list, timeline, detail
afteraction receipt <session-id> [-o file.md]
afteraction risks [--since 7d]           # all flagged events
afteraction doctor                       # show discovered sources, counts, parse warnings
afteraction --version / --help
```

Flags: `--db <path>` (default `~/.afteraction/afteraction.db`), `--port`, `--no-open`, `--source name=path`.
UI binds to `127.0.0.1` only.

## 9. Web UI (local)

1. **Sessions page**: table with date, agent, project, title, duration, events, cost, max-risk badge. Filters: agent, project, date range, risk level. Search across prompts and commands (SQLite FTS5).
2. **Session detail / replay**:
   - Left: vertical timeline of events with icons per kind, timestamps, risk badges. Collapsible thinking/tool results.
   - Right: detail pane — command + output, or file diff (syntax-highlighted), or message text.
   - Top bar: totals (tokens, cost, duration, files touched, risk count) and "Copy receipt" button.
   - Keyboard: `j/k` next/prev event, `r` jump to next risk.
   - "Play" mode: auto-advances through events at adjustable speed.
3. **Files tab** (within session): every touched file with read/write/edit counts; click → combined diff.
4. **Risks page**: all flagged events across sessions, grouped by rule.
5. **Costs page**: bar chart by day, breakdown by project and model.

Design: clean, dense, dark-mode default with light mode; works at 1280px+ (mobile not required).

## 10. Session receipt (Markdown export)

```
### 🛫 Agent session receipt
**Agent:** Claude Code · **Model:** … · **Duration:** 42m · **Est. cost:** $3.18
**Prompt:** "Add Stripe webhook handler…"

**Files changed (5):** src/api/webhook.ts (+120/−4), …
**Commands run (14):** npm test ×4, npm i stripe, git commit …
**⚠️ Risk flags (2):**
- high · secret-file-read · read `.env.local`
- low · package-install · `npm i stripe`

<sub>Generated locally by afteraction vX.Y — transcript not uploaded.</sub>
```

Option `--redact` masks secrets and home-directory paths. Redaction is **on by default** for receipts.

## 11. Architecture

```
packages/
  core/        TypeScript: event model, adapters, risk engine, pricing, ingestion, SQLite (better-sqlite3)
  cli/         commander-based CLI, starts server
  web/         Vite + React + TypeScript + Tailwind; built to static files served by the CLI
fixtures/      anonymized sample logs per agent + expected normalized JSON
```

- Monorepo with pnpm workspaces. Node ≥ 20. TypeScript strict.
- Server: small Hono or Fastify API on localhost serving `/api/sessions`, `/api/sessions/:id/events`, `/api/risks`, `/api/costs`, plus static web build.
- Ingestion is incremental: track `(source_file, size, mtime, hash)`; only parse new/changed files; append-only logs parse from last byte offset.
- Adapters implement:
  ```ts
  interface SourceAdapter {
    id: string;
    discover(): Promise<string[]>;          // log file paths
    parse(file: string): AsyncIterable<NormalizedRecord>;
  }
  ```

## 12. Privacy & security
- Never send data anywhere. No telemetry. State this in README.
- Server binds to 127.0.0.1; reject non-local Host headers (DNS-rebinding protection).
- DB stored with user-only permissions (0600).
- Secrets found by rules are **masked in the UI by default** (click to reveal).
- `afteraction purge [--before 30d]` deletes stored data.

## 13. Quality bar
- Unit tests for every adapter (fixture → expected JSON snapshot) and every risk rule (positive + negative cases).
- Ingestion of 1,000 sessions / 500k events in < 30 s on a laptop; UI session list loads < 300 ms.
- Malformed lines never crash ingestion.
- CI: lint, typecheck, test on macOS + Linux (+ Windows best-effort).

## 14. Milestones
- **M1 — Core:** data model, Claude Code adapter, SQLite, `ingest`/`list`/`show`/`doctor`.
- **M2 — Risk + cost:** rule engine with tests, pricing, `risks`, `receipt`.
- **M3 — Web UI:** sessions, replay, files, risks, costs.
- **M4 — Codex adapter** + cross-agent filters.
- **M5 — Launch polish:** README with GIF, `npx` publish, demo fixture dataset (`afteraction --demo`), GitHub Action stub that posts a receipt.

## 15. v2 ideas (not now)
Cursor/OpenCode/Gemini/Aider adapters · live tail mode · optional LLM "explain this session" (BYO key) · GitHub App posting receipts automatically · team export · pre-execution guard hook that blocks risky commands.

## 16. Success metrics
README GIF + `npx` run in < 60 s from zero · parses 100% of real local sessions on the author's machine without errors · first launch: Show HN + r/ClaudeAI + r/ChatGPTCoding + X.
