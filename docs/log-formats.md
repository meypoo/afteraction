# Agent log formats (observed)

Everything here comes from inspecting real logs on the author's machine on 2026-10-22,
not from documentation or memory. Where a statement is an inference rather than an
observation, it says so.

| Source | Status |
|---|---|
| Claude Code | 27 files, 56,416 lines, versions `2.1.229` – `2.1.304`, Windows 11, entrypoints `cli` and `claude-desktop`. 0 lines failed to parse as JSON. |
| Codex CLI | **Not inspected.** Codex is not installed on this machine: no `~/.codex`, no `CODEX_HOME`, no `codex` on PATH, nothing in either WSL distro. No format is documented below until real logs exist. |

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

## Codex CLI

Not available on this machine. The spec's location `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
is unverified. The Codex adapter (M4) needs real logs before its format can be documented here.

---

## Fixtures

See [`fixtures/README.md`](../fixtures/README.md).
