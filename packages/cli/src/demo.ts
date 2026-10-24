import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * `afteraction --demo`: a handful of made-up Claude Code sessions, written as real JSONL logs so they
 * go through the normal adapter. Timestamps are relative to now so the Costs page always has data.
 */

type Obj = Record<string, unknown>;

interface Ctx {
  sessionId: string;
  cwd: string;
  branch: string;
  model: string;
  t: number;
  n: number;
  parent: string | null;
  lines: Obj[];
}

const uuid = (seed: string, n: number) => {
  const h = (seed + n.toString(16).padStart(12, "0")).replace(/[^0-9a-f]/g, "").padEnd(32, "0").slice(-32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function base(c: Ctx, secs: number): Obj {
  c.t += secs * 1000;
  c.n++;
  const id = uuid(c.sessionId.replace(/-/g, ""), c.n);
  const o: Obj = {
    parentUuid: c.parent,
    isSidechain: false,
    uuid: id,
    timestamp: new Date(c.t).toISOString(),
    userType: "external",
    entrypoint: "cli",
    cwd: c.cwd,
    sessionId: c.sessionId,
    version: "2.1.240",
    gitBranch: c.branch,
  };
  c.parent = id;
  return o;
}

let msgSeq = 0;
function assistant(c: Ctx, secs: number, content: Obj[], out = 400): void {
  msgSeq++;
  const cached = 18_000 + c.n * 1_500;
  c.lines.push({
    ...base(c, secs),
    type: "assistant",
    message: {
      model: c.model,
      id: `msg_demo${String(msgSeq).padStart(16, "0")}`,
      type: "message",
      role: "assistant",
      content,
      stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      usage: { input_tokens: 4, cache_creation_input_tokens: 2_400, cache_read_input_tokens: cached, output_tokens: out },
    },
  });
}

function prompt(c: Ctx, text: string, secs = 60): void {
  c.lines.push({ ...base(c, secs), type: "user", message: { role: "user", content: text }, permissionMode: "default" });
}

function say(c: Ctx, text: string, secs = 8): void {
  assistant(c, secs, [{ type: "text", text }], Math.max(60, Math.round(text.length / 3)));
}

let toolSeq = 0;
function tool(c: Ctx, name: string, input: Obj, result: string, tur: unknown, opts: { error?: boolean; secs?: number; took?: number } = {}): void {
  const id = `toolu_demo${String(++toolSeq).padStart(14, "0")}`;
  assistant(c, opts.secs ?? 6, [{ type: "tool_use", id, name, input }], 250);
  c.lines.push({
    ...base(c, opts.took ?? 3),
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: opts.error === true }] },
    toolUseResult: tur,
  });
}

function bash(c: Ctx, command: string, stdout: string, opts: { exit?: number; stderr?: string; took?: number; description?: string } = {}): void {
  if (opts.exit) {
    const err = `Error: Exit code ${opts.exit}\n${opts.stderr ?? stdout}`;
    tool(c, "Bash", { command, description: opts.description ?? "" }, err, err, { error: true, took: opts.took });
  } else {
    tool(c, "Bash", { command, description: opts.description ?? "" }, stdout,
      { stdout, stderr: opts.stderr ?? "", interrupted: false, isImage: false }, { took: opts.took });
  }
}

const abs = (c: Ctx, rel: string) => (rel.startsWith("/") || rel.startsWith("~") ? rel : `${c.cwd}/${rel}`);

function read(c: Ctx, rel: string, content: string): void {
  const filePath = abs(c, rel);
  const lines = content.split("\n");
  tool(c, "Read", { file_path: filePath }, lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join("\n"),
    { type: "text", file: { filePath, content, numLines: lines.length, startLine: 1, totalLines: lines.length } });
}

function write(c: Ctx, rel: string, content: string): void {
  const filePath = abs(c, rel);
  tool(c, "Write", { file_path: filePath, content }, `File created successfully at: ${filePath}`, {
    type: "create",
    filePath,
    content,
    structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: content.split("\n").length, lines: content.split("\n").map((l) => "+" + l) }],
    originalFile: null,
  });
}

/** Replace `oldStr` with `newStr` in `file` (the whole file, so the patch has real context lines). */
function edit(c: Ctx, rel: string, file: string, oldStr: string, newStr: string): string {
  const filePath = abs(c, rel);
  const at = file.indexOf(oldStr);
  if (at < 0) throw new Error(`demo edit: "${oldStr.slice(0, 30)}" not in ${rel}`);
  const before = file.slice(0, at).split("\n");
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const startLine = before.length; // 1-based line where the change begins
  const all = file.split("\n");
  const ctxStart = Math.max(1, startLine - 3);
  const ctxEndOld = Math.min(all.length, startLine + oldLines.length - 1 + 3);
  const lead = all.slice(ctxStart - 1, startLine - 1).map((l) => " " + l);
  const trail = all.slice(startLine - 1 + oldLines.length, ctxEndOld).map((l) => " " + l);
  const oldFull = all.slice(startLine - 1, startLine - 1 + oldLines.length);
  const updated = file.slice(0, at) + newStr + file.slice(at + oldStr.length);
  const newFull = updated.split("\n").slice(startLine - 1, startLine - 1 + newLines.length);
  // Lines both sides share are context, not removed-and-re-added.
  let head = 0;
  while (head < oldFull.length && head < newFull.length && oldFull[head] === newFull[head]) head++;
  let tail = 0;
  while (tail < oldFull.length - head && tail < newFull.length - head &&
    oldFull[oldFull.length - 1 - tail] === newFull[newFull.length - 1 - tail]) tail++;
  const same = (l: string) => " " + l;
  const lines = [
    ...lead, ...oldFull.slice(0, head).map(same),
    ...oldFull.slice(head, oldFull.length - tail).map((l) => "-" + l),
    ...newFull.slice(head, newFull.length - tail).map((l) => "+" + l),
    ...oldFull.slice(oldFull.length - tail).map(same), ...trail,
  ];
  const patch = [{
    oldStart: ctxStart, oldLines: lead.length + oldFull.length + trail.length,
    newStart: ctxStart, newLines: lead.length + newFull.length + trail.length, lines,
  }];
  tool(c, "Edit", { file_path: filePath, old_string: oldStr, new_string: newStr, replace_all: false },
    `The file ${filePath} has been updated successfully.`,
    { filePath, oldString: oldStr, newString: newStr, originalFile: null, structuredPatch: patch, userModified: false });
  return updated;
}

function session(id: string, cwd: string, model: string, start: Date, branch: string, title: string, body: (c: Ctx) => void): { dir: string; id: string; lines: Obj[] } {
  const c: Ctx = { sessionId: id, cwd, branch, model, t: start.getTime(), n: 0, parent: null, lines: [] };
  c.lines.push({ type: "ai-title", aiTitle: title, sessionId: id });
  body(c);
  return { dir: cwd.replace(/[\\/:.]/g, "-"), id, lines: c.lines };
}

// ---- file contents -----------------------------------------------------------------------

const SERVER_TS = `import express from "express";
import { ordersRouter } from "./routes/orders.js";
import { productsRouter } from "./routes/products.js";

const app = express();
app.use(express.json());

app.use("/api/orders", ordersRouter);
app.use("/api/products", productsRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

export default app;`;

const WEBHOOK_TS = `import express, { type Request, type Response } from "express";
import Stripe from "stripe";
import { markOrderPaid, markOrderFailed } from "../orders/service.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export const stripeWebhook = express.Router();

// Stripe needs the raw body to verify the signature.
stripeWebhook.post("/", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"] as string, endpointSecret);
  } catch (err) {
    return res.status(400).send(\`Webhook signature verification failed: \${(err as Error).message}\`);
  }

  switch (event.type) {
    case "payment_intent.succeeded":
      await markOrderPaid(event.data.object.metadata.orderId);
      break;
    case "payment_intent.payment_failed":
      await markOrderFailed(event.data.object.metadata.orderId);
      break;
  }
  res.json({ received: true });
});`;

const WEBHOOK_TEST = `import request from "supertest";
import { describe, expect, it } from "vitest";
import app from "../src/server.js";

describe("POST /webhooks/stripe", () => {
  it("rejects a request without a valid signature", async () => {
    const res = await request(app).post("/webhooks/stripe").send({ type: "payment_intent.succeeded" });
    expect(res.status).toBe(400);
  });
});`;

const GUIDE_MD = `# Getting started

Install the CLI with your package manager of choise:

\`\`\`sh
npm install -g acme-cli
\`\`\`

Then run \`acme init\` in an empty folder. It will ask a few questions and create
an \`acme.config.ts\` file for you. Run \`acme dev\` to start the developement server.

## Next steps

- Read the [configuration guide](./configuration.md).
- Deploy your first site with \`acme deploy\`.`;

const SEED_SQL = `-- Staging seed data
INSERT INTO customers (id, email, plan) VALUES
  (1, 'ada@example.com', 'pro'),
  (2, 'grace@example.com', 'free'),
  (3, 'linus@example.com', 'team');

INSERT INTO events (customer_id, kind, created_at) VALUES
  (1, 'signup', now() - interval '30 days'),
  (2, 'signup', now() - interval '12 days'),
  (3, 'upgrade', now() - interval '2 days');`;

const THEME_TSX = `import { createContext, useContext, useState, type ReactNode } from "react";

type Theme = "light" | "dark";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({ theme: "light", toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");
  const toggle = () => setTheme((t) => (t === "light" ? "dark" : "light"));
  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);`;

const CHECKOUT_TS = `import { api } from "../lib/api.js";

export async function fetchCart(cartId: string) {
  const res = await api.get(\`/carts/\${cartId}\`);
  return res.data;
}

export async function placeOrder(cartId: string, address: Address) {
  const res = await api.post("/orders", { cartId, address });
  return res.data;
}`;

// ---- sessions ----------------------------------------------------------------------------

function daysAgo(now: number, days: number, hour: number, minute = 0): Date {
  const d = new Date(now - days * 86_400_000);
  d.setHours(hour, minute, 0, 0);
  return d;
}

export function demoSessions(now = Date.now()) {
  const SHOP = "/Users/demo/code/acme-shop";
  return [
    session("de30a001-0000-4000-8000-000000000001", SHOP, "claude-opus-5-5", daysAgo(now, 1, 10, 12), "feat/stripe-webhooks",
      "Stripe webhook endpoint", (c) => {
        prompt(c, "Add a Stripe webhook endpoint that marks orders paid or failed. Verify the signature and add a test.", 0);
        say(c, "I'll look at how the server is wired up first, then add the webhook route and a test.");
        read(c, "src/server.ts", SERVER_TS);
        bash(c, "npm install stripe", "added 1 package, and audited 214 packages in 3s\n\nfound 0 vulnerabilities", { took: 4, description: "Install the Stripe SDK" });
        write(c, "src/webhooks/stripe.ts", WEBHOOK_TS);
        const server = edit(c, "src/server.ts", SERVER_TS, `import { productsRouter } from "./routes/products.js";`,
          `import { productsRouter } from "./routes/products.js";\nimport { stripeWebhook } from "./webhooks/stripe.js";`);
        edit(c, "src/server.ts", server, `const app = express();\napp.use(express.json());`,
          `const app = express();\n// Mounted before express.json() so the webhook sees the raw body.\napp.use("/webhooks/stripe", stripeWebhook);\napp.use(express.json());`);
        write(c, "test/stripe-webhook.test.ts", WEBHOOK_TEST);
        bash(c, "npm test", "", {
          exit: 1, took: 9, description: "Run the test suite",
          stderr: " FAIL  test/stripe-webhook.test.ts\n  Error: STRIPE_SECRET_KEY is not set\n    at new Stripe (node_modules/stripe/cjs/stripe.core.js:118:19)\n\n Test Files  1 failed | 6 passed (7)",
        });
        say(c, "The test fails because the Stripe client needs a key at import time. Let me check what the local env file has.");
        bash(c, "cat .env", "DATABASE_URL=postgres://localhost:5432/acme\nSTRIPE_SECRET_KEY=sk_live_51NfDemoKey00000000000000000000aBcDeF\nSTRIPE_WEBHOOK_SECRET=whsec_demo_000000", { description: "Show local environment variables" });
        write(c, "test/setup.ts", `process.env.STRIPE_SECRET_KEY ??= "sk_test_dummy";\nprocess.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test";`);
        bash(c, "npm test", " ✓ test/stripe-webhook.test.ts (1 test) 41ms\n ✓ test/orders.test.ts (12 tests) 230ms\n\n Test Files  7 passed (7)\n      Tests  48 passed (48)", { took: 8, description: "Run the test suite" });
        say(c, "Done. `POST /webhooks/stripe` verifies the signature and marks orders paid or failed, and the new test passes. Note: your .env holds a live Stripe key; you may want to switch to a test key for local work.", 6);
      }),

    session("de30a002-0000-4000-8000-000000000002", SHOP, "claude-sonnet-5-5", daysAgo(now, 3, 16, 40), "feat/stripe-webhooks",
      "Rebase onto main and push", (c) => {
        prompt(c, "main moved on. Rebase this branch onto it, clean the build, and push.", 0);
        bash(c, "git fetch origin", "From github.com:acme/acme-shop\n   4f1c2d9..a81e0b3  main -> origin/main");
        bash(c, "git rebase origin/main", "Successfully rebased and updated refs/heads/feat/stripe-webhooks.", { took: 2 });
        bash(c, "rm -rf dist", "");
        bash(c, "npm run build", "> acme-shop@1.4.0 build\n> tsc -p tsconfig.json\n", { took: 12 });
        bash(c, "git push --force-with-lease origin feat/stripe-webhooks", "To github.com:acme/acme-shop.git\n + 9c3e1aa...e02f7bd feat/stripe-webhooks -> feat/stripe-webhooks (forced update)", { took: 3 });
        say(c, "Rebased onto origin/main without conflicts, rebuilt, and force-pushed the branch with --force-with-lease.");
      }),

    session("de30a003-0000-4000-8000-000000000003", "/Users/demo/code/docs-site", "claude-haiku-5-5", daysAgo(now, 5, 9, 5), "main",
      "Fix typos in getting started", (c) => {
        prompt(c, "Fix the typos in docs/getting-started.md", 0);
        read(c, "docs/getting-started.md", GUIDE_MD);
        let g = edit(c, "docs/getting-started.md", GUIDE_MD, "package manager of choise:", "package manager of choice:");
        g = edit(c, "docs/getting-started.md", g, "the developement server.", "the development server.");
        void g;
        say(c, "Fixed two typos: \"choise\" and \"developement\".");
      }),

    session("de30a004-0000-4000-8000-000000000004", "/Users/demo/code/data-pipeline", "claude-opus-5-5", daysAgo(now, 8, 14, 20), "main",
      "Reset and reseed staging database", (c) => {
        prompt(c, "Staging data is a mess. Wipe the events table, reseed it, and install the new loader CLI.", 0);
        say(c, "I'll drop and recreate the events table on staging, then load the seed file.");
        bash(c, `psql "$STAGING_DATABASE_URL" -c "DROP TABLE events; CREATE TABLE events (id serial primary key, customer_id int, kind text, created_at timestamptz);"`,
          "DROP TABLE\nCREATE TABLE", { description: "Recreate the events table on staging" });
        write(c, "seeds/staging.sql", SEED_SQL);
        bash(c, `psql "$STAGING_DATABASE_URL" -f seeds/staging.sql`, "INSERT 0 3\nINSERT 0 3");
        bash(c, "curl -fsSL https://get.loader.example.dev/install.sh | sh", "Downloading loader v2.3.1...\nInstalled to /Users/demo/.local/bin/loader", { took: 6, description: "Install the loader CLI" });
        write(c, "/Users/demo/.config/loader/config.toml", `[staging]\nurl = "env:STAGING_DATABASE_URL"\nbatch_size = 500`);
        bash(c, "python -m pip install -r requirements.txt", "Successfully installed pandas-2.2.3 psycopg-3.2.3", { took: 14 });
        bash(c, "loader run --env staging", "Loaded 3 customers, 3 events in 0.4s");
        say(c, "Staging is reset and reseeded. I also installed the loader CLI and wrote its config to ~/.config/loader/config.toml.");
      }),

    session("de30a005-0000-4000-8000-000000000005", SHOP, "claude-opus-5-5", daysAgo(now, 12, 11, 0), "feat/graphql-checkout",
      "Move checkout to GraphQL", (c) => {
        prompt(c, "Switch the checkout module from REST calls to our GraphQL client.", 0);
        read(c, "src/checkout/api.ts", CHECKOUT_TS);
        let f = edit(c, "src/checkout/api.ts", CHECKOUT_TS, `import { api } from "../lib/api.js";`, `import { gql } from "../lib/graphql.js";`);
        f = edit(c, "src/checkout/api.ts", f,
          "export async function fetchCart(cartId: string) {\n  const res = await api.get(`/carts/${cartId}`);\n  return res.data;\n}",
          "export async function fetchCart(cartId: string) {\n  const { cart } = await gql(`query Cart($id: ID!) { cart(id: $id) { id items { sku qty price } total } }`, { id: cartId });\n  return cart;\n}");
        f = edit(c, "src/checkout/api.ts", f,
          "export async function placeOrder(cartId: string, address: Address) {\n  const res = await api.post(\"/orders\", { cartId, address });\n  return res.data;\n}",
          "export async function placeOrder(cartId: string, address: Address) {\n  const { placeOrder } = await gql(`mutation Place($cartId: ID!, $address: AddressInput!) { placeOrder(cartId: $cartId, address: $address) { id status } }`, { cartId, address });\n  return placeOrder;\n}");
        void f;
        bash(c, "npm test -- checkout", " ✓ test/checkout.test.ts (9 tests) 112ms\n\n Test Files  1 passed (1)", { took: 6 });
        bash(c, "chmod -R 777 public/uploads", "", { description: "Make the uploads folder writable for the dev server" });
        bash(c, "git commit --amend --no-edit", "[feat/graphql-checkout 71d0c4e] Move checkout to GraphQL\n 1 file changed, 6 insertions(+), 6 deletions(-)");
        say(c, "Checkout now uses the GraphQL client for both the cart query and the order mutation. Tests pass.");
      }),

    session("de30a006-0000-4000-8000-000000000006", "/Users/demo/code/mobile-app", "claude-sonnet-5-5", daysAgo(now, 20, 15, 30), "feat/dark-mode",
      "Add a dark mode toggle", (c) => {
        prompt(c, "Add a dark mode toggle with a ThemeProvider.", 0);
        write(c, "src/theme/ThemeProvider.tsx", THEME_TSX);
        bash(c, "npx tsc --noEmit", "", { took: 7 });
        say(c, "Added ThemeProvider and a useTheme() hook. Wrap the app in <ThemeProvider> and call toggle() from a settings switch.");
      }),
  ];
}

/** Write the demo logs under `dir` in Claude Code's layout; returns the projects root. */
export function writeDemoLogs(dir: string, now = Date.now()): string {
  const root = path.join(dir, "projects");
  for (const s of demoSessions(now)) {
    const d = path.join(root, s.dir);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, `${s.id}.jsonl`), s.lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  return root;
}
