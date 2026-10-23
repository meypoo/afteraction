# Flight Recorder

**See exactly what your coding agent did: every command, file, risk and dollar, replayed locally.**

```sh
npx flightrec
```

That reads your Claude Code session logs, stores them in a local SQLite database and opens a replay UI at
http://localhost:4317. Nothing leaves your machine.

![Flight Recorder replaying a session](docs/demo.gif)

Want to look around first without touching your own logs?

```sh
npx flightrec --demo
```

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
- **Costs:** estimated spend by day, project and model, and the most expensive sessions.
- **Receipts:** a Markdown summary of a session for a PR comment, with secrets and home paths redacted.

![Sessions list](docs/sessions.png)

## Supported agents

| Agent | Logs read from | Status |
|---|---|---|
| Claude Code | `~/.claude/projects/` | Supported, including subagents |
| Codex CLI | `~/.codex/sessions/` | Planned |

## Commands

```sh
flightrec                          # ingest new logs, then open the UI
flightrec --demo                   # sample sessions, nothing saved
flightrec ingest [--full]          # ingest only
flightrec list [--since 7d] [--project <path>] [--risk high] [--search <text>]
flightrec show <session-id>        # timeline in the terminal
flightrec risks [--since 7d]       # flagged events, grouped by rule
flightrec receipt <session-id|latest> [-o receipt.md]
flightrec purge [--before 30d] --yes   # delete stored sessions (never your agent's logs)
flightrec doctor                   # log sources found, counts, parse warnings
```

Global options: `--db <path>`, `--source claude=<path>`, `--config <path>`, `--port <n>`, `--no-open`.

Session ids can be the full id, the bare UUID, a unique prefix, or `latest`.

### Config file

`~/.flightrec/config.json` (or `--config <path>`) sets defaults; command-line flags win.

```json
{
  "db": "~/flightrec/flightrec.db",
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
  protection).
- Secrets found in logs are masked in the UI until you click "Reveal secrets", and are always redacted in receipts.
- Your data lives in `~/.flightrec/flightrec.db`. Delete it, or run `flightrec purge`, whenever you like.
  Flight Recorder never modifies your agents' log files.

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
      - uses: meypoo/flightrecorder@main
        with:
          log-path: .flightrec/session.jsonl
```

## Development

Requires Node 20+ and pnpm 9.

```sh
pnpm install
pnpm build
pnpm test
pnpm flightrec --demo
```

The repo is a pnpm workspace: `packages/core` (adapters, risk rules, costs, SQLite store), `packages/cli`
(commands and the local server) and `packages/web` (React UI). `pnpm --filter @flightrec/web dev` runs the UI with
hot reload against a running `flightrec` on port 4317. Log format notes live in [docs/log-formats.md](docs/log-formats.md).
