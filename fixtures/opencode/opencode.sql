-- Generated from the OpenCode 1.19.4 schema; rows are synthetic (see fixtures/README.md).
PRAGMA foreign_keys = OFF;
CREATE TABLE `project` (
          `id` text PRIMARY KEY,
          `worktree` text NOT NULL,
          `vcs` text,
          `name` text,
          `icon_url` text,
          `icon_url_override` text,
          `icon_color` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_initialized` integer,
          `sandboxes` text NOT NULL,
          `commands` text
        );
CREATE TABLE `session` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `workspace_id` text,
          `parent_id` text,
          `slug` text NOT NULL,
          `directory` text NOT NULL,
          `path` text,
          `title` text NOT NULL,
          `version` text NOT NULL,
          `share_url` text,
          `summary_additions` integer,
          `summary_deletions` integer,
          `summary_files` integer,
          `summary_diffs` text,
          `metadata` text,
          `cost` real DEFAULT 0 NOT NULL,
          `tokens_input` integer DEFAULT 0 NOT NULL,
          `tokens_output` integer DEFAULT 0 NOT NULL,
          `tokens_reasoning` integer DEFAULT 0 NOT NULL,
          `tokens_cache_read` integer DEFAULT 0 NOT NULL,
          `tokens_cache_write` integer DEFAULT 0 NOT NULL,
          `revert` text,
          `permission` text,
          `agent` text,
          `model` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_compacting` integer,
          `time_archived` integer,
          CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `message` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `part` (
          `id` text PRIMARY KEY,
          `message_id` text NOT NULL,
          `session_id` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
        );
INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES ('prj_demo', 'C:/Users/USER/projects/demo-app', 'git', NULL, 1768471200000, 1768471200000, '[]');
INSERT INTO session (id, project_id, slug, directory, path, title, version, agent, model, time_created, time_updated, tokens_input, tokens_output) VALUES ('ses_fixture00000000000001', 'prj_demo', 'happy-fixture', 'C:/Users/USER/projects/demo-app', '', 'Review the demo app for bugs', '1.19.4', 'build', '{"id": "claude-sonnet-5-5", "providerID": "anthropic"}', 1768471200000, 1768471800000, 0, 0);
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_00010001', 'ses_fixture00000000000001', 1768471200000, 1768471200000, '{"role": "user", "time": {"created": 1768471200000}, "agent": "build", "model": {"providerID": "anthropic", "modelID": "claude-sonnet-5-5"}, "summary": {"diffs": []}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00001', 'msg_00010001', 'ses_fixture00000000000001', 1768471200000, 1768471200000, '{"type": "text", "text": "Review src for bugs and summarize them."}');
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_00010002', 'ses_fixture00000000000001', 1768471201000, 1768471201000, '{"parentID": "msg_user", "role": "assistant", "mode": "build", "agent": "build", "path": {"cwd": "C:\\Users\\USER\\projects\\demo-app", "root": "C:\\Users\\USER\\projects\\demo-app"}, "cost": 0, "tokens": {"total": 2090, "input": 1200, "output": 90, "reasoning": 0, "cache": {"write": 0, "read": 800}}, "modelID": "claude-sonnet-5-5", "providerID": "anthropic", "time": {"created": 1768471201000, "completed": 1768471206000}, "finish": "tool-calls"}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00002', 'msg_00010002', 'ses_fixture00000000000001', 1768471201000, 1768471201000, '{"snapshot": "0000000000000000000000000000000000000000", "type": "step-start"}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00003', 'msg_00010002', 'ses_fixture00000000000001', 1768471201000, 1768471201000, '{"type": "text", "text": "I''ll start by looking at the repository.", "time": {"start": 1768471201100, "end": 1768471201200}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00004', 'msg_00010002', 'ses_fixture00000000000001', 1768471201000, 1768471201000, '{"type": "tool", "tool": "bash", "callID": "call_00_fixture", "state": {"status": "completed", "input": {"command": "git status"}, "output": "On branch main\n", "metadata": {"output": "On branch main\n", "exit": 0, "truncated": false}, "title": "git status", "time": {"start": 1768471201300, "end": 1768471201700}}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00005', 'msg_00010002', 'ses_fixture00000000000001', 1768471201000, 1768471201000, '{"type": "tool", "tool": "read", "callID": "call_01_fixture", "state": {"status": "completed", "input": {"filePath": "C:\\Users\\USER\\projects\\demo-app\\package.json"}, "output": "<file>\n1: {}\n</file>", "metadata": {"preview": "{}", "truncated": false, "loaded": [], "display": {"type": "file", "path": "C:\\Users\\USER\\projects\\demo-app\\package.json", "text": "{}", "lineStart": 1, "lineEnd": 1, "totalLines": 1, "truncated": false}}, "title": "package.json", "time": {"start": 1768471201400, "end": 1768471201800}}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00006', 'msg_00010002', 'ses_fixture00000000000001', 1768471201000, 1768471201000, '{"reason": "tool-calls", "snapshot": "1111111111111111111111111111111111111111", "type": "step-finish", "tokens": {"total": 2090, "input": 1200, "output": 90, "reasoning": 0, "cache": {"write": 0, "read": 800}}, "cost": 0}');
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_00010003', 'ses_fixture00000000000001', 1768471210000, 1768471210000, '{"parentID": "msg_user", "role": "assistant", "mode": "build", "agent": "build", "path": {"cwd": "C:\\Users\\USER\\projects\\demo-app", "root": "C:\\Users\\USER\\projects\\demo-app"}, "cost": 0, "tokens": {"total": 2460, "input": 300, "output": 120, "reasoning": 40, "cache": {"write": 0, "read": 2000}}, "modelID": "claude-sonnet-5-5", "providerID": "anthropic", "time": {"created": 1768471210000, "completed": 1768471215000}, "finish": "tool-calls"}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00007', 'msg_00010003', 'ses_fixture00000000000001', 1768471210000, 1768471210000, '{"snapshot": "0000000000000000000000000000000000000000", "type": "step-start"}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00008', 'msg_00010003', 'ses_fixture00000000000001', 1768471210000, 1768471210000, '{"type": "reasoning", "text": "Check the source folder next.", "time": {"start": 1768471210100, "end": 1768471210150}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00009', 'msg_00010003', 'ses_fixture00000000000001', 1768471210000, 1768471210000, '{"type": "tool", "tool": "read", "callID": "call_00_fixture", "state": {"status": "completed", "input": {"filePath": "C:\\Users\\USER\\projects\\demo-app\\src"}, "output": "<dir listing placeholder>", "metadata": {"preview": "", "truncated": false, "loaded": [], "display": {"type": "directory", "path": "C:\\Users\\USER\\projects\\demo-app\\src", "entries": ["app.ts"], "offset": 1, "totalEntries": 1, "truncated": false}}, "title": "", "time": {"start": 1768471210200, "end": 1768471210600}}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00010', 'msg_00010003', 'ses_fixture00000000000001', 1768471210000, 1768471210000, '{"type": "tool", "tool": "bash", "callID": "call_01_fixture", "state": {"status": "completed", "input": {"command": "npm test", "timeout": 180000}, "output": "1 failing\n", "metadata": {"output": "1 failing\n", "exit": 1, "truncated": false}, "title": "npm test", "time": {"start": 1768471210300, "end": 1768471210700}}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00011', 'msg_00010003', 'ses_fixture00000000000001', 1768471210000, 1768471210000, '{"type": "tool", "tool": "glob", "callID": "call_02_fixture", "state": {"status": "completed", "input": {"pattern": "**/*.env"}, "output": "No files found", "metadata": {"count": 0, "truncated": false}, "title": "**/*.env", "time": {"start": 1768471210900, "end": 1768471211300}}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00012', 'msg_00010003', 'ses_fixture00000000000001', 1768471210000, 1768471210000, '{"reason": "tool-calls", "snapshot": "1111111111111111111111111111111111111111", "type": "step-finish", "tokens": {"total": 2460, "input": 300, "output": 120, "reasoning": 40, "cache": {"write": 0, "read": 2000}}, "cost": 0}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00013', 'msg_00010003', 'ses_fixture00000000000001', 1768471210000, 1768471210000, '{"type": "patch", "hash": "2222222222222222222222222222222222222222", "files": ["C:/Users/USER/projects/demo-app/src/other-program-edit.ts"]}');
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_00010004', 'ses_fixture00000000000001', 1768471220000, 1768471220000, '{"role": "user", "time": {"created": 1768471220000}, "agent": "build", "model": {"providerID": "anthropic", "modelID": "claude-sonnet-5-5"}, "summary": {"diffs": []}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00014', 'msg_00010004', 'ses_fixture00000000000001', 1768471220000, 1768471220000, '{"type": "compaction", "auto": true, "overflow": false, "tail_start_id": "msg_tail"}');
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_00010005', 'ses_fixture00000000000001', 1768471221000, 1768471221000, '{"parentID": "msg_user", "role": "assistant", "mode": "compaction", "agent": "build", "path": {"cwd": "C:\\Users\\USER\\projects\\demo-app", "root": "C:\\Users\\USER\\projects\\demo-app"}, "cost": 0, "tokens": {"total": 5400, "input": 5000, "output": 400, "reasoning": 0, "cache": {"write": 0, "read": 0}}, "modelID": "claude-sonnet-5-5", "providerID": "anthropic", "time": {"created": 1768471221000, "completed": 1768471226000}, "finish": "stop", "summary": true}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00015', 'msg_00010005', 'ses_fixture00000000000001', 1768471221000, 1768471221000, '{"snapshot": "0000000000000000000000000000000000000000", "type": "step-start"}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00016', 'msg_00010005', 'ses_fixture00000000000001', 1768471221000, 1768471221000, '{"type": "text", "text": "## Objective\n- <compaction summary placeholder, 200 chars>", "time": {"start": 1768471221100, "end": 1768471221900}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00017', 'msg_00010005', 'ses_fixture00000000000001', 1768471221000, 1768471221000, '{"reason": "tool-calls", "snapshot": "1111111111111111111111111111111111111111", "type": "step-finish", "tokens": {"total": 5400, "input": 5000, "output": 400, "reasoning": 0, "cache": {"write": 0, "read": 0}}, "cost": 0}');
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_00010006', 'ses_fixture00000000000001', 1768471230000, 1768471230000, '{"role": "user", "time": {"created": 1768471230000}, "agent": "build", "model": {"providerID": "anthropic", "modelID": "claude-sonnet-5-5"}, "summary": {"diffs": []}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00018', 'msg_00010006', 'ses_fixture00000000000001', 1768471230000, 1768471230000, '{"type": "text", "metadata": {"compaction_continue": true}, "synthetic": true, "text": "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.", "time": {"start": 1768471230000, "end": 1768471230000}}');
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_00010007', 'ses_fixture00000000000001', 1768471231000, 1768471231000, '{"parentID": "msg_user", "role": "assistant", "mode": "build", "agent": "build", "path": {"cwd": "C:\\Users\\USER\\projects\\demo-app", "root": "C:\\Users\\USER\\projects\\demo-app"}, "cost": 0, "tokens": {"total": 6270, "input": 200, "output": 60, "reasoning": 10, "cache": {"write": 0, "read": 6000}}, "modelID": "claude-sonnet-5-5", "providerID": "anthropic", "time": {"created": 1768471231000, "completed": 1768471236000}, "finish": "stop"}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00019', 'msg_00010007', 'ses_fixture00000000000001', 1768471231000, 1768471231000, '{"snapshot": "0000000000000000000000000000000000000000", "type": "step-start"}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00020', 'msg_00010007', 'ses_fixture00000000000001', 1768471231000, 1768471231000, '{"type": "reasoning", "text": "", "time": {"start": 1768471231100, "end": 1768471231100}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00021', 'msg_00010007', 'ses_fixture00000000000001', 1768471231000, 1768471231000, '{"type": "text", "text": "Found one failing test in src/app.ts.", "time": {"start": 1768471231200, "end": 1768471231300}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00022', 'msg_00010007', 'ses_fixture00000000000001', 1768471231000, 1768471231000, '{"reason": "tool-calls", "snapshot": "1111111111111111111111111111111111111111", "type": "step-finish", "tokens": {"total": 6270, "input": 200, "output": 60, "reasoning": 10, "cache": {"write": 0, "read": 6000}}, "cost": 0}');
INSERT INTO session (id, project_id, slug, directory, path, title, version, agent, model, time_created, time_updated, tokens_input, tokens_output) VALUES ('ses_fixture00000000000002', 'prj_demo', 'happy-fixture', 'C:/Users/USER/projects/demo-app', '', '', '1.19.4', 'build', '{"id": "claude-sonnet-5-5", "providerID": "anthropic"}', 1768474800000, 1768474900000, 0, 0);
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_00020008', 'ses_fixture00000000000002', 1768474800000, 1768474800000, '{not json');
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_00020009', 'ses_fixture00000000000002', 1768474800001, 1768474800001, '[1, 2]');
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_00020010', 'ses_fixture00000000000002', 1768474800002, 1768474800002, '{"role": "user", "time": {"created": 1768474800002}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00023', 'msg_00020010', 'ses_fixture00000000000002', 1768474800002, 1768474800002, '{"type": "text", "text": "List the files."}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00024', 'msg_00020010', 'ses_fixture00000000000002', 1768474800002, 1768474800002, '{broken');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00025', 'msg_00020010', 'ses_fixture00000000000002', 1768474800002, 1768474800002, '[3]');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00026', 'msg_00020010', 'ses_fixture00000000000002', 1768474800002, 1768474800002, '{"type": "file", "mime": "text/plain", "filename": "notes.txt"}');
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_00020011', 'ses_fixture00000000000002', 1768474800003, 1768474800003, '{"parentID": "msg_user", "role": "assistant", "mode": "build", "agent": "build", "path": {"cwd": "C:\\Users\\USER\\projects\\demo-app", "root": "C:\\Users\\USER\\projects\\demo-app"}, "cost": 0, "tokens": {"total": 15, "input": 10, "output": 5, "reasoning": 0, "cache": {"write": 0, "read": 0}}, "modelID": "claude-sonnet-5-5", "providerID": "anthropic", "time": {"created": 1768474800003, "completed": 1768474805003}, "finish": "error", "error": {"name": "APIError", "data": {"message": "Rate limited"}}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00027', 'msg_00020011', 'ses_fixture00000000000002', 1768474800003, 1768474800003, '{"type": "tool", "tool": "bash", "callID": "call_00_bad", "state": {"status": "error", "input": {"command": "ls /missing"}, "error": "No such file", "time": {"start": 1768474800004, "end": 1768474800009}}}');
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_00020012', 'ses_fixture00000000000002', 1768474800010, 1768474800010, '{"parentID": "msg_user", "role": "assistant", "mode": "build", "agent": "build", "path": {"cwd": "C:\\Users\\USER\\projects\\demo-app", "root": "C:\\Users\\USER\\projects\\demo-app"}, "cost": 0, "tokens": {"total": 10, "input": 7, "output": 3, "reasoning": 0, "cache": {"write": 0, "read": 0}}, "modelID": "claude-sonnet-5-5", "providerID": "anthropic", "time": {"created": 1768474800010, "completed": 1768474805010}, "finish": "tool-calls"}');
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_00020013', 'ses_fixture00000000000002', 1768474800011, 1768474800011, '{"role": "assistant", "time": {"created": "yesterday"}, "tokens": "lots"}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_00028', 'msg_00020013', 'ses_fixture00000000000002', 1768474800011, 1768474800011, '{"type": "text", "text": "Done."}');
