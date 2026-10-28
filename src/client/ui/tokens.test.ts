/**
 * The themes in tokens.css meet WCAG AA, computed from the token values
 * themselves: body text and status text at 4.5:1 on every surface they sit
 * on, UI borders and the focus ring at 3:1. The dark theme is written twice
 * (for "system" and for a chosen dark); the two must be the same.
 */
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, customProperties, parseHex } from "./contrast";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf-8");
const rules = customProperties(css);
const light = rules.get(":root") ?? {};
const darkChosen = rules.get(':root[data-theme="dark"]') ?? {};
const darkSystem = rules.get('@media (prefers-color-scheme: dark) :root:not([data-theme="light"])') ?? {};

const THEMES = [
  ["light", light],
  ["dark", darkChosen],
] as const;

/** Text, and what it is written on */
const TEXT_PAIRS: [string, string][] = [
  ["--color-text", "--color-bg"],
  ["--color-text", "--color-surface"],
  ["--color-text", "--color-surface-sunken"],
  ["--color-text", "--color-surface-hover"],
  ["--color-text", "--color-selected"],
  ["--color-text-muted", "--color-bg"],
  ["--color-text-muted", "--color-surface"],
  ["--color-text-muted", "--color-surface-sunken"],
  ["--color-text-muted", "--color-surface-hover"],
  ["--color-text-muted", "--color-selected"],
  ["--color-accent", "--color-bg"],
  ["--color-accent", "--color-surface"],
  ["--color-accent", "--color-selected"],
  ["--color-text-on-accent", "--color-accent"],
  ["--color-text-on-accent", "--color-accent-hover"],
  ["--color-text-on-danger", "--color-danger"],
];

/** Each status colour as text on its own tint (badges) and on the page and card surfaces */
const STATUS_PAIRS: [string, string][] = ["success", "warning", "danger", "info", "neutral"].flatMap((tone) => [
  [`--color-${tone}`, `--color-${tone}-subtle`],
  [`--color-${tone}`, "--color-surface"],
  [`--color-${tone}`, "--color-bg"],
] as [string, string][]);

/** Borders of controls and the focus ring, against what they sit on */
const UI_PAIRS: [string, string][] = [
  ["--color-border-strong", "--color-bg"],
  ["--color-border-strong", "--color-surface"],
  ["--color-border-strong", "--color-surface-sunken"],
  ["--color-focus", "--color-bg"],
  ["--color-focus", "--color-surface"],
];

function value(theme: Record<string, string>, name: string): string {
  const v = theme[name];
  if (!v || !parseHex(v)) throw new Error(`${name} is not a hex colour in this theme (${v ?? "missing"})`);
  return v;
}

describe("design tokens: contrast", () => {
  it("reads both themes from tokens.css", () => {
    expect(Object.keys(light).length).toBeGreaterThan(20);
    expect(Object.keys(darkChosen).length).toBeGreaterThan(20);
    expect(light["--space-1"]).toBe("4px");
    expect(light["--font-mono"]).toContain("monospace");
  });

  it("writes the dark theme the same for 'system' and for a chosen dark", () => {
    expect(darkSystem).toEqual(darkChosen);
  });

  it("gives every colour token of the light theme a dark value", () => {
    const colours = Object.keys(light).filter((k) => k.startsWith("--color-") || k.startsWith("--shadow-"));
    expect(colours.filter((k) => !(k in darkChosen))).toEqual([]);
  });

  for (const [name, theme] of THEMES) {
    for (const [fg, bg] of TEXT_PAIRS) {
      it(`${name}: ${fg} on ${bg} is at least 4.5:1`, () => {
        expect(contrastRatio(value(theme, fg), value(theme, bg))).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const [fg, bg] of STATUS_PAIRS) {
      it(`${name}: ${fg} on ${bg} is at least 4.5:1`, () => {
        expect(contrastRatio(value(theme, fg), value(theme, bg))).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const [fg, bg] of UI_PAIRS) {
      it(`${name}: ${fg} against ${bg} is at least 3:1`, () => {
        expect(contrastRatio(value(theme, fg), value(theme, bg))).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe("contrast helpers", () => {
  it("computes the WCAG ratio: black on white is 21, a colour on itself is 1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#fff", "#000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    // A known pair: #767676 on white is the classic 4.54:1
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  it("refuses what is not a hex colour", () => {
    expect(() => contrastRatio("red", "#ffffff")).toThrow(/Not a hex colour/);
    expect(parseHex("rgba(0, 0, 0, 0.5)")).toBeNull();
  });

  it("reads custom properties by selector, inside one at-rule too, later declarations winning", () => {
    const parsed = customProperties(`
      /* a comment { with braces } */
      :root { --a: 1px; --b: #fff }
      @media (x) { .y { --c: 2 } .z { --d: 3 } }
      :root { --b: #000; color: red }
    `);
    expect(parsed.get(":root")).toEqual({ "--a": "1px", "--b": "#000" });
    expect(parsed.get("@media (x) .y")).toEqual({ "--c": "2" });
    expect(parsed.get("@media (x) .z")).toEqual({ "--d": "3" });
  });
});
