// Bundles the CLI with @flightrec/core inlined, so the published `flightrec` package is self-contained:
// dist/index.js, prices.json (read by core's cost code relative to the bundle) and web/ (the built UI).
import { build } from "esbuild";
import { cpSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile: path.join(root, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: Object.keys(pkg.dependencies ?? {}),
  logLevel: "warning",
});

cpSync(path.join(root, "../core/prices.json"), path.join(root, "prices.json"));
rmSync(path.join(root, "web"), { recursive: true, force: true });
cpSync(path.join(root, "../web/dist"), path.join(root, "web"), { recursive: true });
