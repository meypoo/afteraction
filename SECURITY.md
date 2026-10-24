# Security notes

Flight Recorder processes local agent transcripts, which can contain commands, file paths, prompts, command
output and credentials. Treat its database (`~/.flightrec/flightrec.db`) and its web UI as sensitive.

Everything in an agent log is untrusted input: a prompt, a file the agent read or a web page it fetched can put
arbitrary text into titles, commands, paths and output. Flight Recorder is built to display that text, never to
act on it.

## What protects what

**Local web UI** (`flightrec`, `packages/cli/src/server.ts`)

- Listens on `127.0.0.1` only and answers only requests whose `Host` is `127.0.0.1`, `localhost` or `[::1]` on its
  own port, which defeats DNS rebinding.
- Each launch generates a random access token. The URL flightrec prints and opens carries it once; the server
  swaps it for an `HttpOnly`, `SameSite=Strict` cookie (named per port) and redirects. Requests without the cookie
  or an `Authorization: Bearer` header get 401. Other local users and processes can reach a loopback port, so this
  is what keeps them out, including from `?reveal=1`.
- The API is read-only (anything but GET/HEAD gets 405) and sends no CORS headers, so a web page in your browser
  can neither change state nor read responses.
- Every response, errors included, carries a strict CSP (`default-src 'self'`, no inline scripts, no framing),
  `nosniff`, `no-referrer` and `X-Frame-Options: DENY`. API responses are `Cache-Control: no-store`.
- Static files are served only if their real path (after resolving symlinks) is inside the web root.
- Query parameters are validated: bad `limit`, `offset` or `since` values are a 400, never an unbounded query.
- The UI renders log content as React text. The one HTML sink is syntax highlighting in diffs, where highlight.js
  escapes the code before adding its own spans; the CSP is a second line of defence.

**Terminal output** (`flightrec list/show/risks/doctor`, `flightrec tui`)

- Control characters in log text are shown as visible stand-ins (`␛`), so escape sequences cannot clear the screen,
  set the window title, plant OSC 8 links or write the clipboard (OSC 52). Bidi override characters, which can make
  a command display differently from what ran, are replaced too.

**Secret masking** (`packages/core/src/receipt.ts`, rule patterns in `packages/core/src/risk.ts`)

- Masked by default in the UI, the TUI, terminal output and `--json` output; `--reveal` / "Reveal secrets" opts out.
  Receipts are redacted (secrets and home-directory paths) unless `--no-redact`.
- Recognised: AWS access keys, Anthropic, OpenAI, GitHub (classic and fine-grained), GitLab, Slack, Google API,
  npm and Hugging Face tokens, Stripe live keys, PEM private keys, plus credentials found by context:
  `*_TOKEN=` / `*_PASSWORD=` / `*_API_KEY=` style assignments, JSON `"password": "…"` fields, `--password`/`--token`
  flags, `Authorization:` headers and `user:password@` in URLs.
- **Masking is best-effort.** It cannot catch every credential format (Azure keys, arbitrary passwords, split or
  encoded secrets). The database always holds the unmasked logs. Do not treat masking as a redaction boundary.

**Receipts and the GitHub Action** (`packages/core/src/receipt.ts`, `action.yml`)

- Every untrusted value in a receipt (prompt, model, paths, commands, risk details) is one inline code span with
  newlines flattened and a fence longer than any backtick run inside, so a PR comment cannot gain links, images,
  @mentions or headings from log content.
- The action ingests only the log you pass (`--no-default-sources`), so other agents' history on a self-hosted
  runner is never read or posted. It runs an exact, pinned `flightrec` version and refuses `latest`. Pin the action
  itself to a tag or commit, give the token only `pull-requests: write`, and avoid `pull_request_target`.

**Ingestion** (`packages/core/src/adapters/*`)

- Logs are parsed as data; nothing in them is executed. Foreign SQLite stores (OpenCode, Cursor) are opened
  read-only. Paths read come from directory listings, never from log content.
- The VS Code (Copilot) chat-log replay refuses `__proto__`/`constructor`/`prototype` keys, so a crafted log cannot
  pollute `Object.prototype`, and cannot grow giant sparse arrays.
- Malformed input (truncated protobuf, out-of-range timestamps, invalid JSON) becomes a parse warning, not a crash.

**Storage**

- The database, its `-wal` and `-shm` files are created user-only (`0600`), and `~/.flightrec` is kept `0700`. On
  Windows these modes are no-ops; access follows your profile directory's ACLs.
- `flightrec purge` turns on `secure_delete`, vacuums and truncates the WAL, so purged rows do not linger in free
  pages.

## Known limitations

- The launch token travels in the URL handed to your browser, so for a moment it is visible in the process list of
  the browser-opening command. Restarting flightrec issues a new one.
- Same-user processes can read `~/.flightrec/flightrec.db` directly; the token protects the port, not the file.
- Whole-file adapters (Gemini CLI, Cline, Continue, Copilot, Aider, Antigravity) read each log into memory. A
  multi-gigabyte log fails that file's ingest with an error; it does not stop the others.
- Risk rules are heuristics with false positives and negatives.

## Reporting a vulnerability

Please do not publish credential-bearing transcripts or proof-of-concept material in a public issue. Report
suspected vulnerabilities privately to the maintainers (GitHub security advisories on this repository) with the
affected version, reproduction steps and impact.
