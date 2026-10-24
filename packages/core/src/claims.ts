// Claims vs evidence: success claims in the agent's messages ("all 9 tests pass", "the build
// succeeds", "fixed") checked against the commands it actually ran before saying so.
// Works on normalized events only, so every adapter gets it. Heuristic, like the risk rules:
// a verdict points at the evidence, it does not prove anything.
import type { NormalizedEvent } from "./model.js";
import { isAgentStatePath, isTempPath, shellSegments, stripHeredocs, type ShellSegment } from "./risk.js";

export type ClaimKind = "tests" | "build" | "typecheck" | "lint" | "fixed";
export type ClaimVerdict = "supported" | "contradicted" | "unverified";
/** A verification command: what it checks and whether it passed. */
export type CheckKind = Exclude<ClaimKind, "fixed">;
export type RunOutcome = "pass" | "fail" | "unknown";

export interface ClaimEvidence {
  event_id: string;
  seq: number;
  command: string;
  exit_code: number | null;
  outcome: RunOutcome;
  passed?: number;
  failed?: number;
}

export interface Claim {
  /** The assistant message the claim was found in. */
  event_id: string;
  seq: number;
  ts: string | null;
  kind: ClaimKind;
  /** The sentence that makes the claim. */
  text: string;
  /** Test counts stated in the claim ("9/9 passed" → passed 9, total 9). */
  claimed?: { passed: number; total?: number };
  verdict: ClaimVerdict;
  /** Why, in one sentence. Never contains log text: the command is in `evidence`, files in `changed_files`. */
  reason: string;
  /** The run the verdict rests on, if any. */
  evidence: ClaimEvidence | null;
  /** Code files changed between that run and the claim. */
  changed_files?: string[];
}

export interface ClaimReport {
  claims: Claim[];
  counts: Record<ClaimVerdict, number>;
}

export const CLAIM_KIND_LABELS: Record<ClaimKind, string> = {
  tests: "tests",
  build: "build",
  typecheck: "typecheck",
  lint: "lint",
  fixed: "fixed",
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ---- claims in messages ----------------------------------------------------------------

const PASS = String.raw`(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|run clean)`;
const TEST_NOUN = String.raw`(?:(?:unit|e2e|integration|regression|new|existing)\s+)?(?:tests?|test suites?|specs?)`;
const ADVERBS = String.raw`(?:(?:now|are|is|all|still|both|also|successfully)\s+)*`;
const OK = String.raw`(?:passes|passed|is clean|are clean|clean|succeeds|succeeded|is green|is happy|is passing)`;

const CLAIM_PATTERNS: { kind: ClaimKind; re: RegExp; counts?: boolean }[] = [
  // 9/9 tests pass, 12/12 passed
  { kind: "tests", counts: true, re: new RegExp(String.raw`\b(\d+)\s*/\s*(\d+)\s+(?:${TEST_NOUN}\s+)?${ADVERBS}${PASS}\b`, "i") },
  // all 12 tests pass, 9 of 9 tests passed
  { kind: "tests", counts: true, re: new RegExp(String.raw`\b(\d+)\s+(?:of\s+(\d+)\s+)?${TEST_NOUN}\s+${ADVERBS}${PASS}\b`, "i") },
  // 9 passed, 0 failed
  { kind: "tests", counts: true, re: /\b(\d+)\s+(?:tests?\s+)?passed\b/i },
  // tests pass, the test suite is green, all tests passing
  { kind: "tests", re: new RegExp(String.raw`\b${TEST_NOUN}\s+${ADVERBS}${PASS}\b`, "i") },
  // passes all (12) tests
  { kind: "tests", counts: true, re: /\bpass(?:es|ed|ing)?\s+all\s+(?:the\s+|of\s+the\s+)?(?:(\d+)\s+)?tests\b/i },
  // the build succeeds, builds successfully, compiled without errors
  { kind: "build", re: /\bbuild\s+(?:(?:now|still|also)\s+)?(?:succeeds|succeeded|passes|passed|works|completes|completed|finished|is (?:green|clean|successful|passing))\b/i },
  { kind: "build", re: /\b(?:builds|built|compiles|compiled)\s+(?:successfully|cleanly|fine|without (?:any\s+)?errors)\b/i },
  { kind: "build", re: /\bsuccessfully\s+(?:built|compiled)\b|\bbuild is (?:clean|green)\b/i },
  // typecheck passes, no type errors, tsc is clean
  { kind: "typecheck", re: new RegExp(String.raw`\b(?:type-?check(?:ing|s)?|type check(?:ing)?|tsc|mypy|pyright|types)\s+(?:now\s+|still\s+)?${OK}\b`, "i") },
  { kind: "typecheck", re: /\b(?:no|zero|0)\s+(?:type|typescript|ts|mypy)\s+errors\b|\btype-?checks?\s+(?:cleanly|successfully|fine)\b/i },
  // lint is clean, eslint passes, no lint errors
  { kind: "lint", re: new RegExp(String.raw`\b(?:lint|linting|linter|eslint|ruff|clippy|flake8|pylint|biome)\s+(?:now\s+|still\s+)?${OK}\b`, "i") },
  { kind: "lint", re: /\b(?:no|zero|0)\s+(?:lint|linting|linter|eslint)\s+(?:errors|warnings|issues|problems)\b|\blint[- ]clean\b/i },
  // I've fixed the bug, this is now fixed, Fixed the race in…
  { kind: "fixed", re: /\b(?:i(?:'ve| have)?|we(?:'ve| have)?|this|that|it|which|has been|have been|is now|are now|now)\s+(?:(?:been|now|also|successfully)\s+)*(?:fixed|resolved)(?![-\w])/i },
  { kind: "fixed", re: /(?:^|[\s*•✅-])(?:fixed|resolved)\s+(?:the|a|an|this|that|it|both|all|those|these)\b/i },
];

/** Words before the claim that make it a plan, a question or a condition, not a statement. */
const HEDGE = /\b(?:should|will|would|could|might|may|once|until|unless|if|whether|make sure|ensure|let me|let's|i'll|we'll|i'm going to|needs? to|try(?:ing)? to|to make|expect(?:ed|s)?|hopefully|probably|verify|confirm|wait(?:ing)? for|so that|in order to)\b/i;
const NEGATION = /\b(?:not|never|no longer|cannot|nor|without)\b|n't\b/i;
/** A clause that reports failures is not a success claim, even if it also says "9 passed". */
const FAILURES = /\b(?:[1-9]\d*|some|one|two|three|several|a few)\s+(?:tests?\s+)?(?:failed|failing|fails?|failures?)\b|\bstill\s+fail/i;

function clauses(text: string): string[] {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, "\n") // pasted output and code are not claims
    .replace(/^\s*>.*$/gm, "\n");
  return prose
    .split(/(?<=[.!?])\s+|\n+|;\s+|,\s+but\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function clip(s: string, max = 200): string {
  const line = s.replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

interface FoundClaim {
  kind: ClaimKind;
  text: string;
  claimed?: { passed: number; total?: number };
}

/** Success claims in one message, at most one per kind (the first). */
export function findClaims(text: string): FoundClaim[] {
  const found = new Map<ClaimKind, FoundClaim>();
  for (const clause of clauses(text)) {
    if (/\?\s*$/.test(clause)) continue;
    for (const { kind, re, counts } of CLAIM_PATTERNS) {
      if (found.has(kind)) continue;
      const m = re.exec(clause);
      if (!m) continue;
      const before = clause.slice(0, m.index);
      if (HEDGE.test(before) || NEGATION.test(before) || /\bnot\b|n't\b/i.test(m[0])) continue;
      if (kind === "tests" && FAILURES.test(clause)) continue;
      const claim: FoundClaim = { kind, text: clip(clause) };
      if (counts && m[1]) {
        const passed = Number(m[1]);
        const total = m[2] ? Number(m[2]) : undefined;
        claim.claimed = total === undefined ? { passed } : { passed, total };
      }
      found.set(kind, claim);
    }
  }
  return [...found.values()];
}

// ---- verification commands -------------------------------------------------------------

const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const EXECERS = new Set(["npx", "bunx", "pnpx"]);
/** Package-manager flags that take a value, so the value is not the script name. */
const PM_VALUE_FLAGS = new Set(["--filter", "-f", "-c", "--dir", "--prefix", "-w", "--workspace", "--cwd"]);

function scriptChecks(name: string): CheckKind[] {
  const n = name.toLowerCase();
  if (/^(test|t|tests|spec|e2e|test:.+)$/.test(n)) return ["tests"];
  if (/^(typecheck|type-check|types|check-types|tsc|typecheck:.+)$/.test(n)) return ["typecheck"];
  if (/^(lint|lint:.+|eslint)$/.test(n)) return ["lint"];
  if (/^(build|build:.+|compile)$/.test(n)) return ["build"];
  if (n === "check" || n === "verify" || n === "ci") return ["tests", "typecheck", "lint"];
  return [];
}

function programChecks(program: string, args: string[]): CheckKind[] {
  const la = args.map((a) => a.toLowerCase());
  const sub = la.find((a) => !a.startsWith("-")) ?? "";
  switch (program) {
    case "vitest": case "jest": case "mocha": case "pytest": case "py.test": case "ava": case "tap": case "phpunit":
    case "rspec": case "karma": case "ctest": case "nextest": case "tox": case "nox":
      return ["tests"];
    case "playwright": case "cypress":
      return sub === "test" || sub === "run" ? ["tests"] : [];
    case "tsc": case "vue-tsc":
      return la.includes("--noemit") ? ["typecheck"] : la.includes("-b") || la.includes("--build") ? ["build", "typecheck"] : ["typecheck", "build"];
    case "mypy": case "pyright": case "flow":
      return ["typecheck"];
    case "eslint": case "ruff": case "flake8": case "pylint": case "golangci-lint": case "rubocop": case "stylelint": case "shellcheck": case "oxlint": case "standard":
      return ["lint"];
    case "biome":
      return sub === "lint" || sub === "check" || sub === "ci" ? ["lint"] : [];
    case "prettier":
      return la.includes("--check") ? ["lint"] : [];
    case "vite": case "next": case "nuxt": case "astro": case "turbo": case "nx":
      if (sub === "build") return ["build"];
      if (program === "turbo" || program === "nx") return scriptChecks(la.filter((a) => !a.startsWith("-") && a !== "run")[0] ?? "");
      return [];
    case "webpack": case "rollup": case "esbuild": case "tsup": case "parcel":
      return ["build"];
    case "go":
      return sub === "test" ? ["tests"] : sub === "build" ? ["build"] : sub === "vet" ? ["lint"] : [];
    case "cargo":
      return sub === "test" || sub === "nextest" ? ["tests"] : sub === "build" ? ["build"] : sub === "check" ? ["typecheck"] : sub === "clippy" ? ["lint"] : [];
    case "dotnet": case "swift":
      return sub === "test" ? ["tests"] : sub === "build" ? ["build"] : [];
    case "deno":
      return sub === "test" ? ["tests"] : sub === "lint" ? ["lint"] : sub === "check" ? ["typecheck"] : [];
    case "mvn": case "mvnw": case "gradle": case "gradlew": {
      const out: CheckKind[] = [];
      if (la.some((a) => /(^|:)(test|check|verify)$/.test(a))) out.push("tests");
      if (la.some((a) => /(^|:)(build|package|compile|assemble|install)$/.test(a))) out.push("build");
      return out;
    }
    case "make":
      if (!sub) return ["build"];
      return scriptChecks(sub === "all" ? "build" : sub);
    case "node":
      return la.includes("--test") ? ["tests"] : [];
    case "python": case "python3": case "py": {
      const i = la.indexOf("-m");
      if (i < 0) return [];
      const mod = la[i + 1] ?? "";
      return mod === "pytest" || mod === "unittest" ? ["tests"] : mod === "mypy" ? ["typecheck"] : ["ruff", "flake8", "pylint"].includes(mod) ? ["lint"] : [];
    }
  }
  if (RUNNERS.has(program)) {
    let rest = args;
    // pnpm --filter web build, npm run test --, yarn workspace x test
    for (;;) {
      const first = rest[0]?.toLowerCase();
      if (first === undefined) return [];
      if (PM_VALUE_FLAGS.has(first)) rest = rest.slice(2);
      else if (first.startsWith("-")) rest = rest.slice(1);
      else if (first === "run" || first === "run-script" || first === "-r" || first === "recursive") rest = rest.slice(1);
      else if (first === "workspace") rest = rest.slice(2);
      else if (first === "exec" || first === "dlx" || first === "x") return segmentChecks({ program: rest[1]?.toLowerCase() ?? "", args: rest.slice(2), sudo: false });
      else break;
    }
    return scriptChecks(rest[0]!);
  }
  if (EXECERS.has(program)) {
    const rest = args.filter((a, i) => !(a.startsWith("-") && i === 0));
    return segmentChecks({ program: (rest[0] ?? "").toLowerCase().replace(/@.*$/, ""), args: rest.slice(1), sudo: false });
  }
  return [];
}

function segmentChecks(s: ShellSegment): CheckKind[] {
  return programChecks(s.program.replace(/\.(cmd|bat|ps1)$/, ""), s.args);
}

/** What a shell command verifies, and whether its exit code speaks for those checks. */
export function classifyCommand(command: string): { checks: CheckKind[]; exitReliable: boolean; chunks: number } {
  const text = stripHeredocs(command);
  // Keep the separators: what follows the last check decides whether the exit code is its own.
  const parts = text.split(/(&&|\|\||[;|\n])/);
  const checks = new Set<CheckKind>();
  let lastCheck = -1;
  let chunks = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const found = shellSegments(parts[i]!).flatMap(segmentChecks);
    if (found.length) {
      found.forEach((c) => checks.add(c));
      lastCheck = i;
      chunks++;
    }
  }
  let exitReliable = true;
  if (/\bpipefail\b/.test(text)) {
    for (let i = lastCheck + 1; i < parts.length; i += 2) if (parts[i] !== "&&" && parts[i] !== "|") exitReliable = false;
  } else {
    for (let i = lastCheck + 1; i < parts.length; i += 2) if (parts[i] !== "&&") exitReliable = false;
  }
  // `npm test || true` and `npm test | tail` both hide the test's exit code.
  if (/\|\|\s*(true|:|exit 0|echo\b)/.test(text)) exitReliable = false;
  return { checks: [...checks], exitReliable, chunks };
}

// ---- reading results from output -------------------------------------------------------

function maxCount(text: string, re: RegExp): number | undefined {
  let best: number | undefined;
  for (const m of text.matchAll(re)) best = Math.max(best ?? 0, Number(m[1]));
  return best;
}

/** Passed/failed counts from common test runner summaries (vitest, jest, pytest, mocha, cargo, node --test). */
export function testCounts(output: string): { passed?: number; failed?: number } {
  const failed = maxCount(output, /\b(\d+)\s+(?:tests?\s+)?(?:failed|failing|failures?)\b/gi) ??
    maxCount(output, /^#\s*fail\s+(\d+)/gim);
  // The "Tests" summary line, not "Test Files", when there is one.
  const testsLine = /^\s*Tests?:?\s{1,}(?!Files).*$/im.exec(output)?.[0];
  const passed = maxCount(testsLine ?? output, /\b(\d+)\s+(?:tests?\s+)?(?:passed|passing)\b/gi) ??
    maxCount(output, /^#\s*pass\s+(\d+)/gim);
  const out: { passed?: number; failed?: number } = {};
  if (passed !== undefined) out.passed = passed;
  if (failed !== undefined) out.failed = failed;
  else if (/^\s*(FAIL\b|--- FAIL:)|\btest result: FAILED\b/m.test(output)) out.failed = 1;
  return out;
}

function outputFailed(checks: CheckKind[], output: string): boolean {
  if (checks.includes("typecheck") && /\berror TS\d+\b|\bFound [1-9]\d* errors?\b/.test(output)) return true;
  if (checks.includes("lint") && /✖ [1-9]\d* problems?|\b[1-9]\d* errors?\b(?!\s*(?:and|,)\s*0)/i.test(output)) return true;
  if (checks.includes("build") && /\b(build failed|failed to compile|compilation failed|error\[E\d+\]|BUILD FAILURE)\b/i.test(output)) return true;
  return false;
}

interface Run extends ClaimEvidence {
  checks: CheckKind[];
}

function runOf(e: NormalizedEvent): Run | null {
  const command = str(e.payload.command);
  if (!command) return null;
  const { checks, exitReliable, chunks } = classifyCommand(command);
  if (!checks.length) return null;
  const exit = typeof e.payload.exit_code === "number" ? e.payload.exit_code : null;
  const output = [e.payload.stdout_excerpt, e.payload.stderr_excerpt, e.payload.result_excerpt, e.payload.error].map(str).filter(Boolean).join("\n");
  const counts = checks.includes("tests") ? testCounts(output) : {};

  let outcome: RunOutcome = "unknown";
  if (e.payload.run_in_background === true) outcome = "unknown";
  else if (exit !== null && exitReliable) outcome = exit === 0 ? "pass" : chunks > 1 ? "unknown" : "fail";
  else if (exit !== null && exit !== 0 && chunks === 1) outcome = "fail";
  else if (exit === null && e.payload.is_error === true && chunks === 1) outcome = "fail";
  if (e.payload.run_in_background !== true) {
    if ((counts.failed ?? 0) > 0 || outputFailed(checks, output)) outcome = "fail";
    else if (outcome === "unknown" && (counts.passed ?? 0) > 0 && counts.failed === undefined && exit === null) outcome = "pass";
    else if (outcome === "unknown" && (counts.passed ?? 0) > 0 && counts.failed === 0) outcome = "pass";
  }
  const run: Run = { event_id: e.id, seq: e.seq, command, exit_code: exit, outcome, checks };
  if (counts.passed !== undefined) run.passed = counts.passed;
  if (counts.failed !== undefined) run.failed = counts.failed;
  return run;
}

// ---- verdicts --------------------------------------------------------------------------

/** Files that are part of the change (not docs, scratch or agent memory). */
function isCodeChange(e: NormalizedEvent): boolean {
  if ((e.kind !== "file_write" && e.kind !== "file_edit") || e.payload.is_error === true) return false;
  const p = str(e.payload.path);
  if (!p || isTempPath(p) || isAgentStatePath(p)) return false;
  return !/\.(md|mdx|txt|rst|adoc)$/i.test(p) && !/(^|[\\/])(docs?|CHANGELOG)([\\/]|$)/i.test(p);
}

const KIND_NOUN: Record<ClaimKind, string> = {
  tests: "test",
  build: "build",
  typecheck: "typecheck",
  lint: "lint",
  fixed: "test, build, typecheck or lint",
};

/** " (exited 1, 2 failed)", or "" when the log has no details. */
function outcomeText(r: Run): string {
  const parts: string[] = [];
  if (r.exit_code !== null) parts.push(`exited ${r.exit_code}`);
  if (r.failed) parts.push(`${r.failed} failed`);
  if (r.passed !== undefined && !r.failed) parts.push(`${r.passed} passed`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function judge(claim: FoundClaim, seq: number, runs: Run[], changes: NormalizedEvent[]): Pick<Claim, "verdict" | "reason" | "evidence" | "changed_files"> {
  const wanted: CheckKind[] = claim.kind === "fixed" ? ["tests", "build", "typecheck", "lint"] : [claim.kind];
  const relevant = runs.filter((r) => r.checks.some((c) => wanted.includes(c)));
  const before = relevant.filter((r) => r.seq < seq);
  const decisive = before.filter((r) => r.outcome !== "unknown");
  const last = decisive.at(-1);
  const evidence = (r: Run): ClaimEvidence => {
    const { checks: _checks, ...rest } = r;
    return rest;
  };

  if (!last) {
    const after = relevant.find((r) => r.seq > seq && r.outcome !== "unknown");
    if (before.length) {
      return { verdict: "unverified", reason: `A ${KIND_NOUN[claim.kind]} command ran before this, but its result could not be read.`, evidence: evidence(before.at(-1)!) };
    }
    if (after) {
      return {
        verdict: "unverified",
        reason: `Claimed before any ${KIND_NOUN[claim.kind]} command ran; the first one afterwards ${after.outcome === "pass" ? "passed" : "failed"}${outcomeText(after)}.`,
        evidence: evidence(after),
      };
    }
    return { verdict: "unverified", reason: `No ${KIND_NOUN[claim.kind]} command was run in this session before the claim.`, evidence: null };
  }
  const changed = changes.filter((e) => e.seq > last.seq && e.seq < seq);
  const changedFiles = [...new Set(changed.map((e) => str(e.payload.path)))];
  // File names stay out of `reason` (it is printed unescaped); they go in changed_files.
  const filesChanged = changedFiles.length === 1 ? "a file changed" : `${changedFiles.length} files changed`;
  if (last.outcome === "fail" && changed.length) {
    // The agent may have fixed it since, but never re-ran the check.
    return {
      verdict: "unverified",
      reason: `The last ${KIND_NOUN[claim.kind]} run failed${outcomeText(last)}; ${filesChanged} after it and it was not re-run.`,
      evidence: evidence(last),
      changed_files: changedFiles,
    };
  }
  if (last.outcome === "fail") {
    return { verdict: "contradicted", reason: `The last ${KIND_NOUN[claim.kind]} run before this claim failed${outcomeText(last)}.`, evidence: evidence(last) };
  }
  if (claim.claimed && last.passed !== undefined && claim.claimed.passed > last.passed) {
    return {
      verdict: "contradicted",
      reason: `Claimed ${claim.claimed.passed} passing, but the last test run reported ${last.passed} passed.`,
      evidence: evidence(last),
    };
  }
  if (claim.claimed?.total !== undefined && last.passed !== undefined && last.failed === undefined && claim.claimed.total > last.passed) {
    return {
      verdict: "contradicted",
      reason: `Claimed ${claim.claimed.passed}/${claim.claimed.total}, but the last test run reported ${last.passed} passed.`,
      evidence: evidence(last),
    };
  }
  if (changed.length) {
    return {
      verdict: "unverified",
      reason: `The last ${KIND_NOUN[claim.kind]} run passed, but ${filesChanged} after it.`,
      evidence: evidence(last),
      changed_files: changedFiles,
    };
  }
  return { verdict: "supported", reason: `The last ${KIND_NOUN[claim.kind]} run before this claim passed${outcomeText(last)}.`, evidence: evidence(last) };
}

/** Find success claims in assistant messages and check each against the commands run before it. */
export function checkClaims(events: NormalizedEvent[]): ClaimReport {
  const runs: Run[] = [];
  const changes: NormalizedEvent[] = [];
  for (const e of events) {
    if (e.kind === "shell_command") {
      const r = runOf(e);
      if (r) runs.push(r);
    } else if (isCodeChange(e)) changes.push(e);
  }
  const claims: Claim[] = [];
  for (const e of events) {
    if (e.kind !== "assistant_message" || e.payload.meta === true) continue;
    const text = str(e.payload.text);
    if (!text) continue;
    for (const found of findClaims(text)) {
      const claim: Claim = { event_id: e.id, seq: e.seq, ts: e.ts, kind: found.kind, text: found.text, ...judge(found, e.seq, runs, changes) };
      if (found.claimed) claim.claimed = found.claimed;
      claims.push(claim);
    }
  }
  const counts: Record<ClaimVerdict, number> = { supported: 0, contradicted: 0, unverified: 0 };
  for (const c of claims) counts[c.verdict]++;
  return { claims, counts };
}

/** One line for terminals and badges: "1 contradicted · 2 unverified · 3 supported". */
export function claimSummary(counts: Record<ClaimVerdict, number>): string {
  const parts = (["contradicted", "unverified", "supported"] as const).filter((v) => counts[v]).map((v) => `${counts[v]} ${v}`);
  return parts.length ? parts.join(" · ") : "no checkable claims";
}
