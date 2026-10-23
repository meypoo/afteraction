import type { ReactNode } from "react";
import { Icon } from "./icons";

/** Icon and tint for each event kind, shared by the timeline, the tape and the detail pane. */
export const KIND: Record<string, { icon: ReactNode; label: string; tint: string }> = {
  user_message: { icon: <Icon.Person />, label: "Prompt", tint: "text-accent bg-accent-soft" },
  assistant_message: { icon: <Icon.Message />, label: "Message", tint: "text-fg-2 bg-raised" },
  thinking: { icon: <Icon.Thought />, label: "Thinking", tint: "text-muted bg-raised" },
  tool_call: { icon: <Icon.Tool />, label: "Tool", tint: "text-fg-2 bg-raised" },
  tool_result: { icon: <Icon.Return />, label: "Result", tint: "text-fg-2 bg-raised" },
  shell_command: { icon: <Icon.Terminal />, label: "Command", tint: "text-fg bg-raised" },
  file_read: { icon: <Icon.FileRead />, label: "Read", tint: "text-fg-2 bg-raised" },
  file_write: { icon: <Icon.FileWrite />, label: "Write", tint: "text-ok bg-ok-soft" },
  file_edit: { icon: <Icon.Edit />, label: "Edit", tint: "text-ok bg-ok-soft" },
  web_fetch: { icon: <Icon.Globe />, label: "Fetch", tint: "text-fg-2 bg-raised" },
  subagent_start: { icon: <Icon.Agent />, label: "Subagent", tint: "text-risk-low bg-risk-low-soft" },
  subagent_end: { icon: <Icon.Flag />, label: "Subagent done", tint: "text-risk-low bg-risk-low-soft" },
  error: { icon: <Icon.Alert />, label: "Error", tint: "text-risk-high bg-risk-high-soft" },
  unknown: { icon: <Icon.Dot />, label: "Other", tint: "text-muted bg-raised" },
};

export const kindOf = (k: string) => KIND[k] ?? KIND.unknown!;

export function KindIcon({ kind, className = "" }: { kind: string; className?: string }) {
  const k = kindOf(kind);
  return (
    <span title={k.label} className={`grid size-5 shrink-0 place-items-center rounded-[5px] [&_svg]:size-3 ${k.tint} ${className}`}>
      {k.icon}
    </span>
  );
}
