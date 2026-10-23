# Agent log formats (observed)

Everything here comes from inspecting real logs on the author's machine on 2026-10-22,
not from documentation or memory. Where a statement is an inference rather than an
observation, it says so.

| Source | Status |
|---|---|
| Claude Code | 27 files, 56,416 lines, versions `2.1.229` – `2.1.304`, Windows 11, entrypoints `cli` and `claude-desktop`. 0 lines failed to parse as JSON. |
| OpenCode | 1 real session on `1.19.4` (one SQLite database for all sessions), 2026-10-23. |
| Google Antigravity | 9 conversations (2025-11 – 2026-09). Conversation files are encrypted; 1 has a readable `transcript.jsonl` (138 lines, 0 parse errors), the rest are metadata only (2026-10-23). |
| Codex | 24 files from Codex Desktop `0.163.0-alpha.11.2`, Windows 11, inspected 2026-10-23. 22 were imports of Claude Code sessions. No Codex CLI rollouts on this machine; CLI-only shapes are from Codex's open-source schema. |

---

## Claude Code

### Locations

Verified on Windows (`~` = `C:\Users\<name>`):

```
~/.claude/
  projects/
    <encoded-cwd>/
      <sessionId>.jsonl                      # one session per file, filename == sessionId
      <sessionId>/
        subagents/agent-<agentId>.jsonl       # subagent (Agent tool) transcript
        subagents/agent-<agentId>.meta.json   # {agentType, description, toolUseId, spawnDepth, ...}
        tool-results/<id>.txt                 # large tool outputs persisted outside the JSONL
        custom-title.json                     # {"customTitle": "..."}
      memory/                                 # Claude's memory notes, NOT logs: ignore
  history.jsonl                               # global prompt history, not needed
  sessions/                                   # runtime state (pid files, keys): ignore
```

- The spec's location `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl` is correct.
- `<encoded-cwd>` replaces `:` and `\` (and `/`) with `-`: `D:\flightrecorder` → `D--flightrecorder`,
  `C:\Users\me` → `C--Users-me`. This is lossy (a real `-` is indistinguishable), so the adapter
  should take `project_path` from the `cwd` field on lines, not decode the directory name.
- `CLAUDE_CONFIG_DIR` was not set here. Inference: when set it replaces `~/.claude`, so discovery should honour it.
- Subagent files carry the **parent** `sessionId`, `isSidechain: true`, and an `agentId` field.
  Their filename does not equal the sessionId. Every subagent line had `isSidechain: true`; every main-file line had `false`.

### Line envelope

Every line is one JSON object with a `type`. Two families exist:

**Transcript lines** (`user`, `assistant`, `system`, `attachment`) share this envelope:

| Field | Notes |
|---|---|
| `uuid`, `parentUuid` | Linked list; `parentUuid` is `null` on the first line. `system/compact_boundary` also has `logicalParentUuid`. |
| `timestamp` | ISO-8601 UTC with ms: `2026-01-15T10:00:00.007Z`. Present on all transcript lines. |
| `sessionId` | Equals filename for main files. Some lines also have snake_case `session_id`, which is a *different* id (remote/bridge session) on 79% of lines that have it: ignore it. |
| `cwd`, `gitBranch` | Per line, so they can change mid-session. Windows paths with backslashes. |
| `version`, `entrypoint`, `userType` | CLI version string, `cli`/`claude-desktop`, `external`. |
| `isSidechain` | `true` only in subagent files. |
| `slug`, `promptId`, `requestId` | Optional. |

**Metadata lines** have only `type`, `sessionId` and a payload, and **no timestamp**:
`custom-title`, `ai-title`, `agent-name`, `last-prompt`, `mode`, `permission-mode`, `atis-latch`,
`bridge-session`, `cost-state`, `pr-link`, `frame-link`, `file-history-snapshot`, `file-history-delta`,
`queue-operation` (has a timestamp), `api-request`, `api-request-blob`, `api-request-shape`,
`artifact-comment-monitor`, `artifact-autoreact-ledger`.

Observed line-type counts across all files:

```
14465 assistant      2673 last-prompt     2421 bridge-session   686 queue-operation   177 ai-title
14259 attachment     2616 custom-title    1044 permission-mode  483 pr-link            30 cost-state
 8023 user           2602 atis-latch       787 api-request-blob 322 system              8 api-request-shape
                     2495 mode             694 file-history-delta 276 api-request        5 artifact-comment-monitor
                     2493 agent-name       194 file-history-snapshot                     4 artifact-autoreact-ledger
                                                                                         3 frame-link
```

Note that metadata lines (`custom-title`, `mode`, etc.) are re-appended many times per session.

### `assistant` lines

```jsonc
{ "type": "assistant", "requestId": "req_…", "uuid": "…", "parentUuid": "…", "timestamp": "…",
  "message": {
    "id": "msg_…", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
    "content": [ /* exactly ONE block */ ],
    "stop_reason": "tool_use" | "end_turn" | "stop_sequence" | null,
    "usage": { … } } }
```

- **One content block per line.** 14,464 of 14,465 lines had exactly one block. A single API
  response (one `message.id`) is split across several lines, e.g. `thinking` then `tool_use`.
- **Usage is repeated on every line of the same message.** It was identical in 7,986 repeats and
  different in 28 (inference: later lines carry the final output count). Token totals must be
  deduplicated by `message.id`, keeping the last line's usage, or they will be overcounted.
- Block types seen: `tool_use` (7,684), `thinking` (4,538), `text` (2,245).
  - `tool_use`: `{id: "toolu_…", name, input, caller: {type: "direct"}}`.
  - `thinking`: `{thinking, signature}`. **80% have an empty `thinking` string** (signature only),
    so thinking text is often unavailable.
- `model` values seen: `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`,
  `claude-haiku-4-5-20251001`, and `<synthetic>` (27 lines; these are local error messages with
  `isApiErrorMessage: true`, zero usage, and must not count as a model or cost).
- `usage` keys: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `cache_creation: {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`,
  `server_tool_use: {web_search_requests, web_fetch_requests}`, `service_tier`, `speed`,
  `inference_geo`, `iterations`, `output_tokens_details`, sometimes `fallback_credit`.
  The 5-minute vs 1-hour cache split matters for pricing (different write prices).
- Other optional line fields: `effort`, `perTurnEffort`, `advisorModel`, `apiBlockIndex`,
  `wireToolInputs` (a map keyed by tool_use id that duplicates tool inputs).

### `user` lines

`message.content` is either a **string** or a **list of blocks**.

**String content (324 lines)** is either a real prompt or a wrapper the CLI injected. Wrappers seen,
by prefix: `<task-notification>`, `<system-reminder>`, `<local-command-caveat>`, `<command-name>`,
`<local-command-stdout>`. Many wrappers also carry `isMeta: true`. Compaction summaries carry
`isCompactSummary: true` and `isVisibleInTranscriptOnly: true`. The session title ("first user
prompt") must skip all of these.

**Block content**: `tool_result` (7,683), `text` (17), `image` (2).

**Tool results** come back as `user` lines with one `tool_result` block plus a structured sidecar:

```jsonc
{ "type": "user", "sourceToolAssistantUUID": "<uuid of the assistant line with the tool_use>",
  "message": { "role": "user", "content": [
     { "type": "tool_result", "tool_use_id": "toolu_…", "content": "…" | [blocks], "is_error": true|false|absent } ] },
  "toolUseResult": { /* tool-specific, see below */ } | "Error: …",
  "permissionDecision": { "decision": "accept", "source": "config" | "user_…" | "hook" } }
```

- `tool_result.content` is a string (6,593), or a list of `text` (778), `image` (277) or
  `tool_reference` (35) blocks.
- `is_error` is `true` (196), `false` (4,512) or absent (2,975). Absent means success.
- **When `is_error` is true, `toolUseResult` is a plain string** starting with `Error: ` in all 196
  cases. Failed shell commands read `Error: Exit code <N>\n<output>`; this is the only place an exit
  code appears. Rejections by the user also show up here as error strings.
- Large outputs are moved to `<sessionId>/tool-results/<id>.txt` and the result content becomes
  `<persisted-output>Output too large (37.2KB). Full output saved to: <path> … Preview (first 2KB): …`.

#### `toolUseResult` shapes by tool (successful calls)

| Tool | `tool_use.input` | `toolUseResult` |
|---|---|---|
| `Bash` | `command`, `description?`, `timeout?`, `run_in_background?` | `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`, `backgroundTaskId?`, `bashEditDiff? {changedFiles, files, moreFiles}`. **No exit code** on success. |
| `PowerShell` (Windows) | same as Bash | `stdout`, `stderr`, `interrupted`, `isImage`, `backgroundTaskId?`, `gitOperation?` |
| `Read` | `file_path`, `offset?`, `limit?` | `{type: "text", file: {filePath, content, numLines, startLine, totalLines, truncatedByTokenCap?}}` or `{type: "image", file: {base64, dimensions, originalSize, type}}` |
| `Write` | `file_path`, `content` | `type: "create"\|"update"`, `filePath`, `content`, `originalFile`, `structuredPatch`, `userModified` |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` | `filePath`, `oldString`, `newString`, `originalFile` (whole file!), `replaceAll`, `structuredPatch: [{oldStart, oldLines, newStart, newLines, lines: ["-…", "+…", " …"]}]`, `userModified`, `contentNotInModelContext?` |
| `Grep` | `pattern`, `path`, `output_mode`, `-n`/`-A`/`head_limit`… | `mode`, `filenames`, `numFiles`, `content?`, `numLines?` |
| `WebFetch` | `url`, `prompt` | `url`, `code`, `codeText`, `bytes`, `durationMs`, `result` |
| `WebSearch` | `query` | `query`, `results`, `durationSeconds`, `searchCount` |
| `Agent` | `description`, `prompt`, `subagent_type`, `run_in_background?` | `agentId`, `status` (`async_launched`, `completed`…), `prompt`, `resolvedModel`, and when finished `content`, `usage`, `totalTokens`, `totalToolUseCount`, `totalDurationMs` |
| `mcp__<server>__<tool>` | arbitrary | a list of content blocks (same as `tool_result.content`) |
| Others seen | `ToolSearch`, `TaskStop`, `Monitor`, `AskUserQuestion`, `ExitPlanMode`, `Skill`, `SendUserFile`, `ReadNotifications`, `Artifact` | tool-specific dicts → map to generic `tool_call` |

Tool-use counts: Bash 4,355 · Edit 712 · Write 677 · Read 623 · PowerShell 284 · MCP tools from several
servers · Grep 55 · WebFetch 18 · Agent 7 · others small. `Glob` and `NotebookEdit` were not seen.

Mapping notes for the adapter:
- `file_edit.unified_diff` can be built from `structuredPatch`; Write with `type: "update"` also has one.
- `Edit.originalFile` holds the entire pre-edit file, so it must not go into excerpts.
- Bash `exit_code`: parse `Error: Exit code N` on failure; on success it is not recorded
  (inference: treat as 0 only if we label it as inferred).

### `system` lines (`subtype`)

| subtype | count | Useful fields |
|---|---|---|
| `turn_duration` | 117 | `durationMs`, `messageCount` |
| `stop_hook_summary` | 76 | `hookCount`, `hookInfos`, `hookErrors`, `preventedContinuation` |
| `away_summary` | 68 | `content` (recap text) |
| `api_error` | 32 | `error`, `retryAttempt`, `maxRetries`, `retryInMs` → `error` event |
| `local_command` | 17 | `content`, `commandRun` |
| `compact_boundary` | 7 | `compactMetadata` (`preTokens`, `postTokens`, `trigger`…) |
| `informational` | 5 | `content` |

### `attachment` lines

`attachment.type` values (counts): `total_tokens_reminder` 5,551 · `hook_additional_context` 2,519 ·
`hook_success` 2,514 · `deferred_tools_record` 2,228 · `edited_text_file` 452 · `silent_turn_reminder` 260 ·
`queued_command` 100 · `deferred_tools_delta` 72 · `environment` 67 · `prompt_snapshot` 57 · `date` 53 ·
plus ~25 rarer types (`skill_listing`, `task_reminder`, `plan_mode`, `file`, `model`, `thinking_drop`…).

These are context injected into the model, not actions. Two are worth surfacing:
- `hook_success` (`hookName` e.g. `PreToolUse:Bash`, `command`, `exitCode`, `stdout`, `stderr`, `durationMs`).
- `edited_text_file` (`filename`, `snippet`): the user edited a file outside the agent.

`prompt_snapshot`, `deferred_tools_record` and the `api-request*` metadata lines contain full system
prompts and request bodies and are large.

### Mapping to the normalized model (proposal)

| Raw | Normalized kind |
|---|---|
| `user` with real string prompt or `text` blocks | `user_message` |
| `user` string wrappers / `isMeta` | skip, or `user_message` flagged meta (not used for title) |
| `assistant` `text` block | `assistant_message` |
| `assistant` `thinking` block | `thinking` (often empty text) |
| `tool_use` Bash / PowerShell | `shell_command` (result merged from the matching `tool_result`) |
| `tool_use` Read | `file_read` |
| `tool_use` Write | `file_write` |
| `tool_use` Edit | `file_edit` |
| `tool_use` WebFetch | `web_fetch` |
| `tool_use` Agent + subagent file | `subagent_start` / `subagent_end` |
| any other `tool_use` (incl. MCP) | `tool_call` |
| `tool_result` with no mapped call | `tool_result` |
| `system/api_error`, `<synthetic>` error messages | `error` |
| unknown `type` or block type | `unknown` (with warning) |
| metadata lines | not events; `custom-title`/`ai-title` can feed the session record |

---

## Codex (CLI and Desktop)

Inspected on 2026-10-23 on Windows 11: 24 rollout files from **Codex Desktop**, `cli_version`
`0.163.0-alpha.11.2`, `originator: "Codex Desktop"`, `source: "vscode"`. No Codex CLI rollouts were on
the machine. The CLI rows below (`function_call` shells, `exec_command_end`, `patch_apply_end`,
`token_count`, the pre-envelope format) come from Codex's open-source rollout schema, not from observed
files; the fixtures for them are hand-written and marked as such.

### Locations

```
~/.codex/                         # or $CODEX_HOME
  sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl   # one thread per file
  archived_sessions/rollout-*.jsonl                            # inference: archived threads move here
  session_index.jsonl, *.sqlite, plugins/, …                   # app state, not logs: ignore
  external_agent_session_imports.json                          # see "Imported sessions" below
```

- The spec's location is correct. The folder date and file-name time are **local** time
  (`rollout-2026-10-23T21-12-21-…` for a thread created at 12:12:21Z in Asia/Tokyo); line timestamps are UTC.
- The thread id (a UUIDv7) is the file-name suffix and `session_meta.payload.id`.
- Discovery walks only `sessions/` and `archived_sessions/` when the root has them, because `~/.codex`
  also holds large plugin and cache folders.

### Imported sessions (important)

Codex Desktop can import other agents' sessions. On this machine 22 of 24 rollouts were copies of
**Claude Code** transcripts, listed in `~/.codex/external_agent_session_imports.json`
(`source_path` → `imported_thread_id`). Ingesting them would count those sessions twice.

An imported rollout's turns all have `turn_id: "external-import-turn-N"` in `task_started` (and in
`item_completed`); their `response_item`s carry no turn id, so the adapter tracks the current turn from
`task_started`. Lines inside import turns are skipped. A file with nothing else yields no session.
If someone continues an imported thread in Codex, only the new turns are kept.

### Line envelope

Every line is `{"timestamp": ISO-8601 UTC, "type": …, "payload": {…}}`. Desktop lines also have an
`ordinal`. Line types seen:

| `type` | Count (24 files) | Use |
|---|---|---|
| `session_meta` | 1 per file, first line | `id`, `cwd`, `cli_version`, `originator`, `git.branch`. Also `base_instructions` (large; dropped from `raw`). |
| `turn_context` | 1 per turn | `model` (e.g. `gpt-5.6-terra`), `cwd`, `approval_policy`, `sandbox_policy`. |
| `response_item` | most lines | The model conversation, see below. |
| `event_msg` | many | UI stream; mostly mirrors response items. Used for command results, errors and usage. |
| `token_usage_record` | 1 per model response (Desktop) | `usage` for that response. |
| `world_state` | a few | App state snapshots (AGENTS.md text, approved command prefixes). Ignored. |
| `compacted` | CLI schema only | Summary that replaced earlier history; kept as a `user_message` with `compact_summary`. |

Early CLI rollouts (schema) had no envelope: a bare `{id, timestamp, instructions, git}` first line,
then bare response items and `{"record_type": "state"}` lines. The adapter reads those too.

### `response_item` payloads

| `payload.type` | Notes |
|---|---|
| `message` | `role` `user` / `assistant` / `developer`. Content parts `input_text` / `output_text` / `input_image`. Assistant messages have `phase` (`commentary`, `final_answer`). |
| `reasoning` | `summary: [{type: "summary_text", text}]`, `encrypted_content`. Of 13 real items, 9 had an empty summary; none had readable full text. |
| `custom_tool_call` / `custom_tool_call_output` | Free-form tool input. In Desktop the only one seen is `exec` (below). In the CLI schema `apply_patch` uses it. |
| `function_call` / `function_call_output` | JSON `arguments` string. CLI shells: `shell` / `container.exec` / `shell_command` / `exec_command` with `command` (argv array or string) or `cmd`, and `workdir`. |
| `local_shell_call` | CLI schema: `action: {type: "exec", command: [...], working_directory}`. |
| `web_search_call` | CLI schema: `action: {type: "search", query}`. |
| `additional_tools` | Tool definitions sent to the model. Ignored. |

**User messages that are not typed by the person.** Desktop marks each message with
`internal_chat_message_metadata_passthrough.content_item_kinds`; the typed prompt is `user.text`.
Others seen: `agents_md.instructions`, `environments.environment_context`,
`additional_content.codex_apps_open_page`. Without that field (CLI), injected context starts with
`<environment_context>`, `<user_instructions>` or `# AGENTS.md instructions`. Both become
`user_message` with `meta: true`; the title is the first typed prompt.

**Desktop `exec` scripts.** Codex Desktop calls tools from a JavaScript cell:
`custom_tool_call {name: "exec", input: "const r = await tools.exec_command({cmd, workdir}); text(r.output);"}`.
The commands and patches the script ran are logged separately, after the call and before its output, as
`event_msg {type: "item_completed", item: {type: "CommandExecution" | "FileChange"}}`. The adapter turns
those items into `shell_command` / file events (marked `via: "exec"`) and drops the script call itself;
a script that ran no command (e.g. listing tools) stays a `tool_call` named `exec`.

`CommandExecution`: `command` argv (`[".../pwsh.exe", "-Command", "<script>"]`), `cwd` as a
`file:///D:/…` URL, `parsed_cmd`, `status` (`completed`, inferred also `failed`/`declined`),
`aggregated_output`, `exit_code`, `duration {secs, nanos}`.

`FileChange`: `changes: {"<abs path>": {type: "add", content} | {type: "update", unified_diff, move_path} | {type: "delete"}}`.
Only `add` was observed; the other shapes are inferred from the CLI schema.

`item_completed` also carries `UserMessage`, `AgentMessage` and `Reasoning` items. They duplicate
response items and are ignored.

### Results and usage

- CLI shell results: `function_call_output.output` is either a JSON string
  `{"output": …, "metadata": {"exit_code", "duration_seconds"}}` or plain text
  `Exit code: N\nWall time: … seconds\nOutput:\n…`. `event_msg/exec_command_end` (same `call_id`) has
  `exit_code`, `aggregated_output` and `duration`, and wins when present.
- CLI patch results: `event_msg/patch_apply_end {call_id, success, stdout, stderr}`.
- Usage, Desktop: `token_usage_record.usage` = `{input_tokens, cached_input_tokens,
  cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`, one per response.
  `event_msg/token_count` repeats the same numbers (`last_token_usage`) and is ignored when records exist.
- Usage, CLI: `event_msg/token_count.info.last_token_usage`; `info` can be `null`, and a count can repeat
  with unchanged `total_token_usage`, which is skipped.
- OpenAI's `input_tokens` **includes** `cached_input_tokens`. The adapter stores
  `tokens_in = input − cached − cache_write` and `cache_read = cached`, matching the Claude Code meaning.
  That cache writes are also inside `input_tokens` is an inference: every real record had 0 writes.
  `reasoning_output_tokens` is part of `output_tokens`.
- Prices: `prices.json` has OpenAI's Standard-tier text models (`openai_source`, checked 2026-10-23).
  OpenAI's 30-minute and 12-hour cache-write prices go in `cache_write_5m` / `cache_write_1h`; logs don't say
  which cache was written, so writes are priced at the 30-minute rate. Models with no cached or write price
  are charged the input rate for those tokens. Above 272K prompt tokens the long-context rates apply.
  `gpt-5-codex` and other Codex models missing from OpenAI's page stay unpriced rather than guessed.

### Mapping

| Source | Event |
|---|---|
| typed user `message` | `user_message` |
| injected user `message` | `user_message`, `meta: true` |
| `developer` / `system` `message` | not an event |
| assistant `message` | `assistant_message` |
| `reasoning` | `thinking` (`summary_only` when only the summary exists, `redacted` when empty) |
| shell `function_call` / `local_shell_call` / `CommandExecution` | `shell_command` |
| `apply_patch` / `FileChange` add | `file_write`, `operation: "create"` (one event per file) |
| `apply_patch` / `FileChange` update | `file_edit` with `unified_diff` |
| `apply_patch` / `FileChange` delete | `file_write`, `operation: "delete"` |
| `web_search_call` | `tool_call` named `web_search` (`web_fetch` if it has a URL) |
| other tool calls | `tool_call` |
| output with no known call | `tool_result` |
| `event_msg/turn_aborted`, `error`, `stream_error` | `error` |
| unknown line or response item type | `unknown` (with warning) |
| unknown `event_msg` type | warning only, once per type per file |

---

## OpenCode

Inspected 2026-10-23: schema on `1.18.29`, then one real session on `1.19.4` (npm global install,
Windows 11, provider `opencode`, model `big-pickle`): 1 session, ~70 messages, ~270 parts, including an
automatic compaction.

### Location

`~/.local/share/opencode/opencode.db` (SQLite, WAL mode, so `-wal`/`-shm` sit next to it and
hold recent writes). Same path on Windows. `XDG_DATA_HOME` is assumed to move it (inference, not
observed). `log/opencode.log` is a process log; `snapshot/` holds git snapshots of the worktree.
No JSON `storage/` directory in these versions.

### Tables read

- `session`: `id`, `project_id`, `parent_id` (child sessions, not observed), `directory`
  (forward slashes: `D:/proj`), `title` (generated), `version`, `agent`, `model`
  (`{"id","providerID"}`), `cost`, `tokens_input/output/reasoning/cache_read/cache_write` (sums of the
  message usage), `time_created`/`time_updated` (Unix **milliseconds**).
- `message`: `id`, `session_id`, `time_created`, `data` (JSON). Ids sort by time (`msg_…`).
- `part`: `id`, `message_id`, `session_id`, `data` (JSON). Ids sort in order within a message.

Never read: `account`, `credential`, `control_account` (access tokens). Other tables (`event`,
`todo`, `permission`, `session_share`, `session_message`, `session_input`) are not needed.

### `message.data`

```json
{ "role": "user", "time": {"created": 1792761653662}, "agent": "build",
  "model": {"providerID": "opencode", "modelID": "big-pickle"}, "summary": {"diffs": [...]} }
{ "role": "assistant", "parentID": "msg_…", "mode": "build" | "compaction", "agent": "build",
  "path": {"cwd": "D:\proj", "root": "D:\proj"}, "modelID": "big-pickle", "providerID": "opencode",
  "cost": 0, "tokens": {"total", "input", "output", "reasoning", "cache": {"read", "write"}},
  "time": {"created", "completed"}, "finish": "tool-calls" | "stop", "summary": true }
```

`summary: true` with `mode: "compaction"` marks the compaction summary message. The user message's
`summary.diffs` is a worktree diff, not the user's work.

### `part.data` types

| `type` | Content |
|---|---|
| `text` | `text`, `time.{start,end}`; `synthetic: true` for the injected "Continue…" after compaction |
| `reasoning` | `text` (can be empty), `time` |
| `tool` | `tool`, `callID`, `state: {status, input, output, metadata, title, time: {start, end}}` |
| `step-start` / `step-finish` | `snapshot` hash; `step-finish` repeats the message's `tokens` and `cost` |
| `patch` | `hash`, `files`: files that changed in the worktree during the step |
| `compaction` | `auto`, `overflow`, `tail_start_id` (in a user message) |

**`patch` parts are not the agent's edits.** During the real session they listed files that another
program changed in the same folder at the same time. The adapter ignores them.

Tools seen: `bash` (`input.command`, optional `input.timeout`; `metadata.exit`, `metadata.output`,
`metadata.truncated`) and `read` (`input.filePath`, a file or a directory; `metadata.display.type`).
Only `completed` status was seen. `write`, `edit` and other tools have not been seen yet, so they are
kept as `tool_call` with their input until a real session shows their shape.

### What the adapter does

- One session per row: `discover()` returns `<db>#<session id>` for each, because ingest works per
  file. The fingerprint is the session's update time plus its message and part counts.
- Usage is per assistant message and goes on its first event; reasoning tokens count as output.
  Model is `modelID`, so models in `prices.json` get a cost; others show "—".
- `project_path` is the first assistant `path.cwd` (backslashes, matching other agents), else
  `session.directory`.

---

## Google Antigravity

Inspected 2026-10-23, Antigravity IDE installed at `D:\Antigravity`, data last written 2026-09-05.

### Locations

`~/.gemini/antigravity/` (with older copies in `antigravity-backup/` and `antigravity-ide/`):

| Path | Content | Readable |
|---|---|---|
| `conversations/<uuid>.pb` | one file per conversation (9 here, 67 KB – 3.2 MB) | **No.** Byte entropy ≈ 8.0 bits/byte and no compression magic: encrypted. |
| `implicit/<uuid>.pb` | 6 files, up to 11 MB | No, same as above. |
| `agyhub_summaries_proto.pb` | plain protobuf, one entry per conversation | Yes (no `.proto` schema; field meanings inferred) |
| `brain/<uuid>/` | agent artifacts per conversation: `task.md`, `implementation_plan.md`, `walkthrough.md`, each with `.metadata.json` and numbered `.resolved.N` revisions, plus browser screenshots (`*.png`, `*.webp`) | Yes |
| `annotations/<uuid>.pbtxt` | `last_user_view_time` only | Yes |
| `code_tracker/active/no_repo/<md5>_<file>` | copies of files the agent touched | Yes, but no link to a conversation |
| `antigravity_state.pbtxt` | onboarding state and last selected model (`MODEL_…` enum) | Yes |

`%APPDATA%\Antigravity\User\globalStorage\state.vscdb` holds IDE state (auth, theme, agent-manager
init state) but no transcripts.

### `agyhub_summaries_proto.pb` (inferred field meanings)

Repeated field 1, each `{1: conversation uuid, 2: summary}`. In the summary: `1` title (string),
`2` step count (varint, inferred), `3` last-modified `{seconds, nanos}`, `7` created
`{seconds, nanos}`, `9.1` workspace `file:///` URI, `4`/`17.3`/`17.18` further uuids (meaning
unknown), `16` and `22` varints (unknown).

### `brain/*.metadata.json`

```json
{ "artifactType": "ARTIFACT_TYPE_TASK", "summary": "<one-line description>", "updatedAt": "<ISO-8601>" }
```

### `brain/<uuid>/.system_generated/logs/transcript.jsonl` (readable, newer versions only)

Found for 1 of 9 conversations (the only one written in 2026-09; 138 lines, all valid JSON). The
others predate it. The log starts at `step_index` 25, so earlier steps of a conversation can be
missing. Same folder: `messages/<uuid>.json` (background-task notifications, with the original
`toolCall.argumentsJson` and a `toolu_vrtx_…` call id), `tasks/task-N.log` (background command output),
`click_feedback/*.png`.

One JSON object per step:

```json
{ "step_index": 31, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
  "created_at": "2026-09-05T11:04:38Z", "content": "…", "thinking": "…",
  "tool_calls": [{ "name": "run_command", "args": { "CommandLine": "\"npm run dev\"", "Cwd": "\"d:\\\\proj\"", "WaitMsBeforeAsync": "5000" } }],
  "error": "…" }
```

- `source`: `USER_EXPLICIT`, `MODEL`, `SYSTEM`. `status`: `DONE`, `RUNNING` (background task started).
- **Every `args` value is itself JSON-encoded** (`"\"list\""`, `"5000"`, `"true"`, arrays as JSON text).
  Newer lines add `toolAction` / `toolSummary` (UI labels).
- No model id, no token counts, no cost anywhere in the transcript.

| `type` | Meaning |
|---|---|
| `USER_INPUT` | prompt, wrapped in `<USER_REQUEST>…</USER_REQUEST>` plus `<ADDITIONAL_METADATA>` |
| `PLANNER_RESPONSE` | model turn: optional `thinking`, `content`, `tool_calls` (one per line observed) |
| `RUN_COMMAND`, `VIEW_FILE`, `CODE_ACTION`, `GREP_SEARCH`, `LIST_DIRECTORY`, `GENERIC` | result of the previous tool call. `content` starts `Created At: <ts>\nCompleted At: <ts>\n`; commands then say `The command failed with exit code: N` or `The command completed successfully.` then `Output:`; edits carry a diff between `[diff_block_start]` and `[diff_block_end]` |
| `ERROR_MESSAGE` | `error` (quota, invalid tool call) |
| `SYSTEM_MESSAGE`, `EPHEMERAL_MESSAGE`, `CONVERSATION_HISTORY` | injected by Antigravity, not actions |

Tools seen: `run_command`, `view_file`, `write_to_file` (`IsArtifact: true` for brain documents),
`replace_file_content`, `multi_replace_file_content` (`ReplacementChunks`), `grep_search`, `list_dir`,
`manage_task`, `schedule`.

### What the adapter does

- One session per conversation. Discovery takes `brain/<uuid>/…/transcript.jsonl` when it exists,
  else `conversations/<uuid>.pb`. Title, workspace and times come from the summaries file.
- With a transcript: full timeline (prompts, thinking, commands with exit codes and output, reads,
  edits with diffs, errors). Artifact writes become `tool_call`, not `file_write`, so Antigravity's own
  folder is not flagged as a write outside the project.
- Without one (encrypted only): metadata-only session, with one `assistant_message` per brain
  document (`payload.metadata_only: true`). No timeline, commands, risks or cost.
- Cost is shown as unknown ("—"), never $0, because no token usage is logged.
- If Antigravity later writes readable transcripts somewhere else, add a reader next to
  `parseTranscript` in `packages/core/src/adapters/antigravity.ts`.

---

## Fixtures

See [`fixtures/README.md`](../fixtures/README.md).
