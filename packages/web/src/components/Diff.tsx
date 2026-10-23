/** Unified diff with added/removed lines coloured. */
export function Diff({ text }: { text: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <pre className="overflow-auto rounded border border-line bg-bg p-2 text-xs leading-5">
      {lines.map((l, i) => {
        let cls = "";
        if (l.startsWith("@@")) cls = "text-sky-600 dark:text-sky-400";
        else if (l.startsWith("+")) cls = "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
        else if (l.startsWith("-")) cls = "bg-red-500/10 text-red-700 dark:text-red-300";
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
