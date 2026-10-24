<p align="center">
  <img src="site/favicon.svg" width="56" height="56" alt="">
</p>

<h1 align="center">Afteraction</h1>

<p align="center">
  <b>See exactly what your coding agent did: every command, file, risk and dollar, replayed locally.</b>
</p>

<p align="center">
  <a href="https://github.com/meypoo/afteraction/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/meypoo/afteraction/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white">
  <img alt="100% local" src="https://img.shields.io/badge/data-100%25%20local-0f766e">
  <a href="https://www.npmjs.com/package/afteraction"><img alt="npm" src="https://img.shields.io/npm/v/afteraction?color=cb3837&logo=npm"></a>
  <img alt="Agents" src="https://img.shields.io/badge/agents-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenCode%20%C2%B7%20more-d97757">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">
  <a href="https://meypoo.github.io/afteraction/"><b>Website</b></a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-you-get">Features</a> ·
  <a href="#claims-vs-evidence">Claims vs evidence</a> ·
  <a href="#in-the-terminal">Terminal UI</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#privacy">Privacy</a>
</p>

<p align="center">
  <img src="docs/demo.gif" alt="Afteraction replaying a Claude Code session: a flagged cat .env, a supported and a contradicted claim, then the Risks and Costs pages" width="900">
</p>

## Quick start

```sh
npx afteraction
```

That reads your Claude Code session logs, stores them in a local SQLite database and opens a replay UI at
http://localhost:4317 (the link it opens carries a one-off access token). Nothing leaves your machine.

Want to look around first without touching your own logs?

```sh
npx afteraction --demo
```

Prefer the terminal, or working over SSH? `npx afteraction tui` opens the same data full-screen.

## Why

Coding agents run for hours and write detailed logs, but in raw JSONL nobody reads. Afterwards it's hard to answer:

- What commands did it run? Did it do anything dangerous?
- Which files did it read (including `.env`) and change?
- What did that session cost, and which task burned the tokens?
- How was this PR produced, not just what's in the diff?

## What you get

- **Sessions:** every session across your projects, searchable by prompt and command, filterable by agent,
  project, date and risk, with an estimated cost column.
- **Replay:** a timeline of prompts, messages, commands, file reads and edits next to the detail of each event
  (command output, diffs, message text). `j`/`k` step, `r` jumps to the next risk, space plays it back.
- **Files:** every file a session touched, with read/write/edit counts and a combined diff.
- **Risks:** rule-based flags such as `rm -rf`, force pushes, history rewrites, reading `.env` or keys, API keys in
  output, `curl | sh`, `DROP TABLE`, package installs, writes outside the project.
- **Claims vs evidence:** when the agent says "tests pass", "9/9 passed", "build succeeds", "lint clean" or "fixed",
  Afteraction checks the commands it actually ran before saying so and marks each claim supported, contradicted or
  unverified, with the run that decided it.
- **Costs:** estimated spend by day, project and model, and the most expensive sessions.
- **Receipts:** a Markdown summary of a session for a PR comment, with secrets and home paths redacted.

<table>
  <tr>
    <td width="50%"><img src="docs/sessions.png" alt="Sessions list with cost and risk columns"><br><sub><b>Sessions:</b> every run across your projects, with cost and risk at a glance.</sub></td>
    <td width="50%"><img src="docs/replay.png" alt="Replay of a session with a flagged cat .env command"><br><sub><b>Replay:</b> step through the timeline; risky events are flagged and secrets masked.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/check.png" alt="A 'tests pass' claim marked contradicted by a failed jest run"><br><sub><b>Claims vs evidence:</b> "all 9 tests pass", contradicted by the jest run before it.</sub></td>
    <td width="50%"><img src="docs/costs-light.png" alt="Costs page in the light theme"><br><sub><b>Costs:</b> estimated spend by day, project and model (light theme shown).</sub></td>
  </tr>
</table>

## Claims vs evidence

Agents end a run with a summary: "tests pass", "build succeeds", "fixed". Afteraction reads that summary, finds the
last matching test, build, lint or typecheck run before it, and marks each claim **supported**, **contradicted** or
**unverified**, with the command that decided it. You see the verdict in the replay, in `afteraction claims <id>`
and in the PR receipt.

```text
❌ contradicted · tests · "tsc is clean and all 9 tests pass."
   The last test run before this claim failed (exited 1, 1 failed). · ran npx jest src/theme
✅ supported · typecheck · "tsc is clean and all 9 tests pass."
   The last typecheck run before this claim passed (exited 0). · ran npx tsc --noEmit
```

## In the terminal

<p align="center">
  <img src="docs/tui.png" alt="afteraction tui showing a flagged cat .env command" width="760">
</p>

```sh
afteraction tui                 # browse all sessions
afteraction tui latest          # jump straight into the newest one
afteraction tui --demo          # try it on sample data
```

`j`/`k` move, `enter` opens a session or event, `r`/`R` jump to the next or previous risk, `/` filters, `s` reveals
masked secrets, `esc` goes back and `q` quits. It needs an interactive terminal; in scripts use `afteraction list` and
`afteraction show`.

## Supported agents

| Agent | Logs read from | Status |
|---|---|---|
| Claude Code | `~/.claude/projects/` | Supported, including subagents |
| Codex (CLI and Desktop) | `~/.codex/sessions/` | Supported; sessions Codex imported from other agents are skipped |
| OpenCode | `~/.local/share/opencode/opencode.db` | Supported (prompts, replies, reasoning, commands, file reads; writes and edits mapped from the tool definitions, not yet seen in a real log; other tools listed as tool calls) |
| Google Antigravity | `~/.gemini/antigravity/` | Full timeline where Antigravity wrote a readable `transcript.jsonl`; otherwise title, project, times and plan documents only, because conversation files are encrypted. No token or cost data |
| Gemini CLI | `~/.gemini/tmp/*/chats/` | Unverified: built from Gemini CLI's source, not yet tested on real sessions |
| Cursor | Cursor's `globalStorage/state.vscdb` | Unverified: built from Cursor's code, not yet tested on real chats |
| GitHub Copilot (VS Code) | VS Code's `workspaceStorage/*/chatSessions/` | Unverified: built from VS Code's code, checked on two small chats. No token or cost data |
| Cline, Roo Code, Kilo Code | the extension's `globalStorage/…/tasks/` in VS Code, Cursor, Windsurf and others | Unverified: built from Cline's source, not yet tested on real tasks |
| Aider | `.aider.chat.history.md` in your repositories (searched under your home folder) | Unverified: built from Aider's source, not yet tested on real history files |
| Continue | `~/.continue/sessions/` | Unverified: built from Continue's source, not yet tested on real sessions |

## Commands

```sh
afteraction                          # ingest new logs, then open the UI
afteraction --demo                   # sample sessions, nothing saved
afteraction ingest [--full]          # ingest only
afteraction list [--since 7d] [--project <path>] [--agent codex] [--risk high] [--search <text>]
afteraction show <session-id>        # timeline in the terminal
afteraction tui [session-id]         # full-screen browser in the terminal (j/k, r for next risk; works over SSH)
afteraction risks [--since 7d]       # flagged events, grouped by rule
afteraction claims <session-id>      # "tests pass", "fixed" … checked against the commands actually run
afteraction receipt <session-id|latest> [-o receipt.md]
afteraction purge [--before 30d] --yes   # delete stored sessions (never your agent's logs)
afteraction doctor                   # log sources found, counts, parse warnings
```

Global options: `--db <path>`, `--source claude=<path>`, `--no-default-sources` (read only the `--source`s you name),
`--config <path>`, `--port <n>`, `--no-open`. `--json` output masks secrets too; add `--reveal` for the raw values.

Session ids can be the full id, the bare UUID, a unique prefix, or `latest`.

### Config file

`~/.afteraction/config.json` (or `--config <path>`) sets defaults; command-line flags win.

```json
{
  "db": "~/afteraction/afteraction.db",
  "port": 4317,
  "sources": { "claude": "~/.claude/projects" }
}
```

## Costs are estimates

Costs are computed from the token counts in the logs and a bundled price table (`prices.json`), at API list
prices. If you're on a subscription plan you aren't billed per token; treat the numbers as "what this would have
cost on the API".

## Privacy

- 100% local. No telemetry, no accounts, no network calls.
- The UI server listens on `127.0.0.1` only and rejects requests with a non-local `Host` header (DNS-rebinding
  protection). Each launch makes a random access token: the link afteraction opens trades it for a cookie, and requests
  without it are refused, so other users and programs on the same machine cannot read your sessions through the port.
  The API is read-only.
- Secrets found in logs are masked in the UI, the terminal and `--json` output until you ask to reveal them, and are
  redacted in receipts. Masking is pattern-based and best-effort: see [SECURITY.md](SECURITY.md).
- Your data lives in `~/.afteraction/afteraction.db`. Delete it, or run `afteraction purge`, whenever you like.
  Afteraction never modifies your agents' log files.

## Receipts on pull requests (GitHub Action, experimental)

CI runners don't have your agent history, so commit or upload the session log you want to show, then:

```yaml
on: pull_request
permissions:
  pull-requests: write
jobs:
  receipt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: meypoo/afteraction@<release tag or commit SHA>
        with:
          log-path: .afteraction/session.jsonl
```

The action reads only the log you give it (never other agent history on the runner) and runs the exact
`afteraction` version in its `version` input. Pin the action itself to a tag or commit, and prefer `pull_request` over
`pull_request_target`.

## Development

Requires Node 20+ and pnpm 9.

```sh
pnpm install
pnpm build
pnpm test
pnpm afteraction --demo
```

The repo is a pnpm workspace: `packages/core` (adapters, risk rules, costs, SQLite store), `packages/cli`
(commands and the local server) and `packages/web` (React UI). `pnpm --filter @afteraction/web dev` runs the UI with
hot reload against a running `afteraction` on port 4317. Log format notes live in [docs/log-formats.md](docs/log-formats.md).

## License

[MIT](LICENSE)
