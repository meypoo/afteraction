import { useMemo } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGS = { bash, css, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);

const BY_EXT: Record<string, keyof typeof LANGS> = {
  sh: "bash", bash: "bash", zsh: "bash", ps1: "bash",
  css: "css", scss: "css",
  go: "go", java: "java", kt: "java",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  json: "json", jsonc: "json",
  md: "markdown", mdx: "markdown",
  py: "python", rs: "rust", sql: "sql",
  html: "xml", xml: "xml", svg: "xml", vue: "xml",
  yml: "yaml", yaml: "yaml", toml: "yaml",
};

function languageFor(path?: string): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path ?? "")?.[1]?.toLowerCase();
  return (ext && BY_EXT[ext]) || null;
}

/**
 * Highlight each side of the diff as one block (so multi-line strings and comments come out right),
 * then split the HTML back into lines. hljs closes and reopens spans per line only within a block,
 * so a line keeps whatever spans are still open from the line before.
 */
function highlightLines(code: string[], lang: string): string[] {
  const html = hljs.highlight(code.join("\n"), { language: lang, ignoreIllegals: true }).value;
  const out: string[] = [];
  const open: string[] = [];
  for (const line of html.split("\n")) {
    const prefix = open.join("");
    for (const m of line.matchAll(/<span[^>]*>|<\/span>/g)) {
      if (m[0] === "</span>") open.pop();
      else open.push(m[0]);
    }
    out.push(prefix + line + "</span>".repeat(open.length));
  }
  return out;
}

/** Unified diff with added/removed lines coloured and code syntax-highlighted by file extension. */
export function Diff({ text, path }: { text: string; path?: string }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const html = useMemo(() => {
    const lang = languageFor(path);
    if (!lang) return null;
    // Old side = context + removed lines, new side = context + added lines.
    const oldIdx: number[] = [];
    const newIdx: number[] = [];
    lines.forEach((l, i) => {
      if (l.startsWith("@@")) return;
      if (!l.startsWith("+")) oldIdx.push(i);
      if (!l.startsWith("-")) newIdx.push(i);
    });
    const result: (string | null)[] = lines.map(() => null);
    try {
      const oldHtml = highlightLines(oldIdx.map((i) => lines[i]!.slice(1)), lang);
      const newHtml = highlightLines(newIdx.map((i) => lines[i]!.slice(1)), lang);
      oldIdx.forEach((i, k) => (result[i] = oldHtml[k]!));
      newIdx.forEach((i, k) => (result[i] = newHtml[k]!));
    } catch {
      return null;
    }
    return result;
  }, [lines, path]);

  return (
    <pre className="hljs-diff overflow-auto rounded border border-line bg-bg p-2 text-xs leading-5">
      {lines.map((l, i) => {
        let cls = "";
        if (l.startsWith("@@")) cls = "text-sky-600 dark:text-sky-400";
        else if (l.startsWith("+")) cls = "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
        else if (l.startsWith("-")) cls = "bg-red-500/10 text-red-700 dark:text-red-300";
        const h = html?.[i];
        if (h != null) {
          return (
            <div key={i} className={`whitespace-pre ${cls}`}>
              <span className="select-none opacity-60">{l[0]}</span>
              <span dangerouslySetInnerHTML={{ __html: h || " " }} />
            </div>
          );
        }
        return (
          <div key={i} className={`whitespace-pre ${cls}`}>
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}

/** Show new file content as an all-added diff. */
export function asAddedDiff(content: string): string {
  const lines = content.replace(/\n$/, "").split("\n");
  return `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => "+" + l).join("\n") + "\n";
}
