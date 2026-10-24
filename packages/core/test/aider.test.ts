import { describe, expect, it } from "vitest";
import path from "node:path";
import { aiderAdapter } from "../src/adapters/aider.js";
import { collect, FIXTURES_ROOT } from "./helpers.js";

const ROOT = path.join(FIXTURES_ROOT, "aider");
const HIST = path.join(ROOT, "demo-app", ".aider.chat.history.md");
const REPO = path.dirname(HIST);

describe("aider adapter", () => {
  it("lists runs that have a prompt, skipping node_modules and hidden folders", async () => {
    // run 1 has no prompt (only startup notices)
    expect(await aiderAdapter.discover(ROOT)).toEqual([`${HIST}#0`, `${HIST}#2`]);
  });

  it("maps prompts, replies and Aider's notices", async () => {
    const { events, warnings } = await collect(aiderAdapter, `${HIST}#0`);
    expect(warnings).toEqual([]);
    expect(events.map((e) => [e.kind, e.summary])).toEqual([
      ["user_message", "Add a retry to the login request. Use three attempts."],
      ["assistant_message", expect.stringMatching(/^I'll add a retry loop\./)],
      ["file_edit", `Edit ${path.join(REPO, "src", "login.py")}`],
      ["tool_call", "git commit abc1234: feat: Add retry to login request"],
      ["shell_command", "$ pytest"],
      ["shell_command", "$ git status"],
      ["user_message", "(empty prompt)"],
      ["assistant_message", "Is there anything else?"],
    ]);
    expect(events[0]!.payload.text).toBe("Add a retry to the login request.\nUse three attempts.");
    expect(events[5]!.payload).toMatchObject({ user_initiated: true, cwd: REPO });
  });

  it("reads usage lines, the model and the local start time", async () => {
    const { events, sessions } = await collect(aiderAdapter, `${HIST}#0`);
    expect(events.filter((e) => e.tokens_in !== null).map((e) => [e.seq, e.tokens_in, e.cache_read, e.tokens_out])).toEqual([
      [1, 1300, 1000, 120],
      [7, 12000, 0, 45],
    ]);
    expect(events[1]!.model).toBe("claude-sonnet-5-5");
    expect(sessions[0]).toMatchObject({
      source: "aider",
      project_path: REPO,
      model: "claude-sonnet-5-5",
      title: "Add a retry to the login request. Use three attempts.",
      started_at: new Date(2026, 0, 15, 10, 0, 0).toISOString(),
      total_input_tokens: 13300,
      total_output_tokens: 165,
    });
    expect(sessions[0]!.id).toMatch(/^aider:[0-9a-f]{8}-20260115100000-0$/);
  });

  it("reads later runs in the same file on their own", async () => {
    const { events, sessions } = await collect(aiderAdapter, `${HIST}#2`);
    expect(events.map((e) => e.kind)).toEqual(["user_message", "assistant_message"]);
    expect(events[1]).toMatchObject({ tokens_in: 1500000, tokens_out: 2, model: "gpt-5" });
    expect(sessions[0]!.title).toBe("What does main.py do?");
  });

  it("matches the expected normalized snapshot", async () => {
    // Paths and local times depend on the machine, so they are replaced before comparing.
    const { events, sessions } = await collect(aiderAdapter, `${HIST}#0`);
    const snapshot = {
      session: { ...sessions[0], id: "<id>", source_file: "<fixture>", source_hash: "<hash>", started_at: "<local>", ended_at: "<local>" },
      events: events.map(({ raw: _raw, ...rest }) => ({ ...rest, id: "<id>", session_id: "<id>", ts: "<local>" })),
    };
    const text = JSON.stringify(snapshot, null, 2)
      .split(JSON.stringify(REPO).slice(1, -1))
      .join("<repo>")
      .replace(/<repo>((?:\\\\[\w.-]+)+)/g, (_, rest: string) => "<repo>" + rest.replaceAll("\\\\", "/"));
    await expect(text + "\n").toMatchFileSnapshot(path.join(ROOT, "expected", "run-0.json"));
  });

  it("warns for a run that does not exist", async () => {
    expect((await collect(aiderAdapter, `${HIST}#9`)).warnings).toHaveLength(1);
    expect((await collect(aiderAdapter, HIST)).warnings).toHaveLength(1);
  });
});
