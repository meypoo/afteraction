# Fixtures

Anonymized sample logs for adapter tests. No real log content is committed here.

## How they were made

`claude-code/projects/…` was generated from real Claude Code logs by a script that keeps the JSON
structure and enum-like values (`type`, `subtype`, `model`, `version`, `stop_reason`, tool names,
token counts) and replaces everything else:

- free text (prompts, replies, tool output, file contents, titles) → `<key placeholder, N chars>`
- ids (`uuid`, `toolu_…`, `msg_…`, `req_…`, agent ids) → deterministic fake ids, consistently remapped so
  `parentUuid`, `tool_use_id`, `sourceToolAssistantUUID` and repeated `message.id` links still hold
- file paths → `C:\Users\USER\projects\demo-app\src\fileN.ext`
- shell commands → harmless placeholders (`npm test`, `git status`, …)
- timestamps → rebased to 2026-01-15
- MCP tool names other than `mcp__playwright__*` → `mcp__example__tool_N`
- `parentUuid` rewritten into a linear chain, because lines were sampled from several sessions

The output was then checked against the real logs: no real uuid or tool/message id appears, and no
string outside the placeholder patterns remains.

## Files

### `claude-code/projects/C--Users-USER-projects-demo-app/`

Mirrors the real `~/.claude/projects/<encoded-cwd>/` layout, so discovery can be tested too.

- `11111111-2222-4333-8444-555555555555.jsonl` (101 lines): at least one of every line type,
  `system` subtype, common `attachment` type and tool seen in real logs, each `tool_use` followed by its
  `tool_result`. Includes an `Agent` call, an API error (`<synthetic>` model), a failed tool call with a
  string `toolUseResult`, Edit/Write `structuredPatch`, a user message with an image block, and assistant messages split across
  several lines that share one `message.id`.
- `11111111-…/subagents/agent-a0000000000000001.jsonl` + `.meta.json`: the subagent transcript for
  that `Agent` call (first 8 lines + last line), `isSidechain: true`.

### `claude-code/malformed/22222222-3333-4444-8555-666666666666.jsonl`

Hand-written. Expected handling, by line:

| Line | Content | Expected |
|---|---|---|
| 1 | `custom-title` metadata | metadata, not an event |
| 2 | valid user prompt | `user_message` |
| 3 | assistant line cut off mid-object | warning (file:3), skipped |
| 4 | blank | skipped silently |
| 5 | JSON array | warning, skipped |
| 6 | JSON string | warning, skipped |
| 7 | not JSON | warning, skipped |
| 8 | unknown line `type` | `unknown` event + warning |
| 9 | assistant with unknown content block type | `unknown` event + warning |
| 10 | assistant line with no `message` | `unknown` event + warning |
| 11 | orphan `tool_result` with an invalid timestamp | `tool_result`, no crash |
| 12 | valid user prompt | `user_message` |
| 13 | truncated last line, no trailing newline | warning, skipped |

### Codex

None yet: Codex CLI is not installed on the machine the formats were taken from.

Expected normalized snapshots will be added next to these files with the adapter tests.
