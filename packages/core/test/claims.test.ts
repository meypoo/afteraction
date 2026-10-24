import { describe, expect, it } from "vitest";
import { checkClaims, claimSummary, classifyCommand, findClaims, testCounts } from "../src/claims.js";
import type { EventKind, NormalizedEvent } from "../src/model.js";

let seq = 0;
function ev(kind: EventKind, payload: Record<string, unknown>): NormalizedEvent {
  return {
    id: `s:${seq}`, session_id: "s", seq: seq++, ts: null, kind, summary: "", payload, raw: null,
    tokens_in: null, tokens_out: null, cache_read: null, cache_write: null, usage_extra: null, model: null,
    risk_level: "none", risk_rules: [],
  };
}
const say = (text: string) => ev("assistant_message", { text });
const sh = (command: string, exit_code: number | null, stdout_excerpt?: string, extra: Record<string, unknown> = {}) =>
  ev("shell_command", { command, exit_code, stdout_excerpt, is_error: exit_code !== null && exit_code !== 0, ...extra });
const edit = (path: string) => ev("file_edit", { path, lines_added: 1, lines_removed: 1, is_error: false });

describe("findClaims", () => {
  const kinds = (t: string) => findClaims(t).map((c) => c.kind);

  it("finds success claims of each kind", () => {
    expect(kinds("All tests pass now.")).toEqual(["tests"]);
    expect(kinds("9/9 passed")).toEqual(["tests"]);
    expect(kinds("The test suite is green and the build succeeds.")).toEqual(["tests", "build"]);
    expect(kinds("Typecheck passes and lint is clean.")).toEqual(["typecheck", "lint"]);
    expect(kinds("No type errors, no lint warnings.")).toEqual(["typecheck", "lint"]);
    expect(kinds("I've fixed the off-by-one in the pager.")).toEqual(["fixed"]);
    expect(kinds("- Fixed the race in the session loader")).toEqual(["fixed"]);
    expect(kinds("It compiles cleanly.")).toEqual(["build"]);
  });

  it("reads counts", () => {
    expect(findClaims("All 12 tests pass.")[0]!.claimed).toEqual({ passed: 12 });
    expect(findClaims("9/9 tests passed")[0]!.claimed).toEqual({ passed: 9, total: 9 });
    expect(findClaims("9 of 10 tests passed")[0]!.claimed).toEqual({ passed: 9, total: 10 });
  });

  it("skips plans, questions, negations and failure reports", () => {
    for (const t of [
      "Let me make sure the tests pass.",
      "Once the build succeeds I'll commit.",
      "Do the tests pass?",
      "The tests don't pass yet.",
      "The build is not passing.",
      "8 passed, 1 failed.",
      "Tests still fail on Windows.",
      "We should verify that lint is clean.",
      "This uses a fixed-width font.",
      "```\nTests  9 passed (9)\n```",
      "> all tests pass",
    ]) {
      expect(kinds(t), t).toEqual([]);
    }
  });
});

describe("classifyCommand", () => {
  it("knows common runners", () => {
    expect(classifyCommand("npm test").checks).toEqual(["tests"]);
    expect(classifyCommand("pnpm --filter web run build").checks).toEqual(["build"]);
    expect(classifyCommand("npx vitest run").checks).toEqual(["tests"]);
    expect(classifyCommand("python -m pytest -q").checks).toEqual(["tests"]);
    expect(classifyCommand("cargo clippy -- -D warnings").checks).toEqual(["lint"]);
    expect(classifyCommand("tsc --noEmit").checks).toEqual(["typecheck"]);
    expect(classifyCommand("cd app && go test ./...").checks).toEqual(["tests"]);
    expect(classifyCommand("npm install").checks).toEqual([]);
    expect(classifyCommand("git status").checks).toEqual([]);
  });

  it("knows when the exit code is not the check's", () => {
    expect(classifyCommand("npm test").exitReliable).toBe(true);
    expect(classifyCommand("npm test && echo ok").exitReliable).toBe(true);
    expect(classifyCommand("npm test 2>&1 | tail -20").exitReliable).toBe(false);
    expect(classifyCommand("set -o pipefail; npm test | tail -20").exitReliable).toBe(true);
    expect(classifyCommand("npm test || true").exitReliable).toBe(false);
    expect(classifyCommand("npm test; echo done").exitReliable).toBe(false);
  });
});

describe("testCounts", () => {
  it("reads runner summaries", () => {
    expect(testCounts(" Test Files  2 passed (2)\n      Tests  9 passed (9)")).toEqual({ passed: 9 });
    expect(testCounts("Tests:       1 failed, 9 passed, 10 total")).toEqual({ passed: 9, failed: 1 });
    expect(testCounts("===== 2 failed, 7 passed in 0.12s =====")).toEqual({ passed: 7, failed: 2 });
    expect(testCounts("test result: ok. 9 passed; 0 failed; 0 ignored")).toEqual({ passed: 9, failed: 0 });
    expect(testCounts("--- FAIL: TestParse (0.00s)\nFAIL")).toEqual({ failed: 1 });
    expect(testCounts("# pass 4\n# fail 0")).toEqual({ passed: 4, failed: 0 });
  });
});

describe("checkClaims", () => {
  it("supports a claim backed by a passing run", () => {
    const { claims } = checkClaims([sh("npm test", 0, "Tests  9 passed (9)"), say("All 9 tests pass.")]);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: "tests", verdict: "supported", evidence: { command: "npm test", passed: 9 } });
  });

  it("contradicts a claim when the last run failed", () => {
    const { claims } = checkClaims([sh("npm test", 1, "Tests  2 failed | 7 passed (9)"), say("Done, 9/9 tests pass.")]);
    expect(claims[0]!.verdict).toBe("contradicted");
    expect(claims[0]!.reason).toContain("exited 1, 2 failed");
  });

  it("contradicts a claim that overstates the count", () => {
    const { claims } = checkClaims([sh("npx vitest run src/a.test.ts", 0, "Tests  3 passed (3)"), say("All 12 tests pass.")]);
    expect(claims[0]!.verdict).toBe("contradicted");
    expect(claims[0]!.reason).toBe("Claimed 12 passing, but the last test run reported 3 passed.");
  });

  it("does not trust an exit code hidden by a pipe, but reads the output", () => {
    const failed = checkClaims([sh("npm test 2>&1 | tail -5", 0, "Tests:       1 failed, 9 passed, 10 total"), say("Tests pass.")]);
    expect(failed.claims[0]!.verdict).toBe("contradicted");
    const unread = checkClaims([sh("npm test 2>&1 | tail -5", 0, "…"), say("Tests pass.")]);
    expect(unread.claims[0]!.verdict).toBe("unverified");
    expect(unread.claims[0]!.reason).toContain("could not be read");
  });

  it("leaves a claim unverified when nothing was run", () => {
    const { claims } = checkClaims([edit("/p/src/a.ts"), say("The build succeeds and lint is clean.")]);
    expect(claims.map((c) => [c.kind, c.verdict, c.evidence])).toEqual([["build", "unverified", null], ["lint", "unverified", null]]);
  });

  it("notes a check that only ran after the claim", () => {
    const { claims } = checkClaims([say("Tests pass."), sh("pnpm test", 1)]);
    expect(claims[0]!.verdict).toBe("unverified");
    expect(claims[0]!.reason).toContain("Claimed before any test command ran; the first one afterwards failed");
  });

  it("marks a passing run stale when code changed after it", () => {
    const events = [sh("npm test", 0), edit("/p/src/a.ts"), edit("/p/README.md"), say("All tests pass.")];
    const { claims } = checkClaims(events);
    expect(claims[0]!.verdict).toBe("unverified");
    expect(claims[0]!.reason).toBe("The last test run passed, but a file changed after it.");
    expect(claims[0]!.changed_files).toEqual(["/p/src/a.ts"]);
    // A docs-only edit does not make it stale.
    expect(checkClaims([sh("npm test", 0), edit("/p/README.md"), say("All tests pass.")]).claims[0]!.verdict).toBe("supported");
  });

  it("does not call a claim contradicted when code changed after the failing run", () => {
    const { claims } = checkClaims([sh("npm test", 1, "1 failing"), edit("/p/src/form.ts"), say("Tests pass.")]);
    expect(claims[0]!.verdict).toBe("unverified");
    expect(claims[0]!.reason).toBe("The last test run failed (exited 1, 1 failed); a file changed after it and it was not re-run.");
    expect(claims[0]!.changed_files).toEqual(["/p/src/form.ts"]);
  });

  it("checks 'fixed' against any verification run", () => {
    expect(checkClaims([sh("go test ./...", 0), say("I've fixed the parser bug.")]).claims[0]!.verdict).toBe("supported");
    expect(checkClaims([sh("cargo build", 101, "error[E0308]: mismatched types"), say("Fixed the type error.")]).claims[0]!.verdict).toBe("contradicted");
    expect(checkClaims([say("This is now fixed.")]).claims[0]!.verdict).toBe("unverified");
  });

  it("uses is_error when an adapter has no exit code", () => {
    const run = ev("shell_command", { command: "npm run lint", exit_code: null, is_error: true });
    expect(checkClaims([run, say("Lint passes.")]).claims[0]!.verdict).toBe("contradicted");
  });

  it("ignores background runs and meta messages", () => {
    const bg = sh("npm test", 0, undefined, { run_in_background: true });
    expect(checkClaims([bg, say("Tests pass.")]).claims[0]!.verdict).toBe("unverified");
    const meta = ev("assistant_message", { text: "Tests pass.", meta: true });
    expect(checkClaims([meta]).claims).toEqual([]);
  });

  it("counts verdicts", () => {
    const report = checkClaims([sh("npm test", 0), say("Tests pass."), say("The build succeeds."), sh("npm run lint", 1), say("Lint is clean.")]);
    expect(report.counts).toEqual({ supported: 1, contradicted: 1, unverified: 1 });
    expect(claimSummary(report.counts)).toBe("1 contradicted · 1 unverified · 1 supported");
    expect(claimSummary({ supported: 0, contradicted: 0, unverified: 0 })).toBe("no checkable claims");
  });
});
