import { describe, expect, it } from "vitest";
import { safeTerminal, safeTerminalDeep } from "../src/format.js";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI8 = String.fromCharCode(0x9b); // 8-bit CSI, read as ESC [ by some terminals
const RLO = String.fromCharCode(0x202e);

describe("safeTerminal", () => {
  it("neutralises escape sequences, C1 controls and bidi overrides", () => {
    const attacks = [
      `${ESC}]52;c;ZXZpbA==${BEL}`, // OSC 52: write the clipboard
      `${ESC}]0;fake title${BEL}`, // window title
      `${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`, // hyperlink
      `${ESC}[2J${ESC}[H`, // clear screen
      `${CSI8}31m`,
      `rm -rf ~ ${RLO}gnp.exe`,
      "safe\rrm -rf /",
    ];
    for (const a of attacks) {
      const out = safeTerminal(a);
      // eslint-disable-next-line no-control-regex -- matching control characters is the point
      expect(out, JSON.stringify(a)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    }
    expect(safeTerminal(`${ESC}[31mred`)).toBe("␛[31mred");
  });

  it("keeps newlines, tabs and ordinary Unicode", () => {
    expect(safeTerminal("a\tb\nc → ✓ ünï")).toBe("a\tb\nc → ✓ ünï");
    expect(safeTerminal("dos\r\nline")).toBe("dos\nline");
  });

  it("works through nested values", () => {
    expect(safeTerminalDeep({ a: [`${ESC}x`], n: 1 })).toEqual({ a: ["␛x"], n: 1 });
  });
});
