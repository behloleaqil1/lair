/**
 * WCAG contrast from colour values, and the custom properties of a CSS file
 * by selector: tokens.test.ts checks the themes in tokens.css with them.
 */

/** sRGB channels 0-255 of #rgb or #rrggbb; null for anything else */
export function parseHex(value: string): [number, number, number] | null {
  const hex = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
  if (short) return [short[1], short[2], short[3]].map((c) => parseInt(c + c, 16)) as [number, number, number];
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
  if (long) return [long[1], long[2], long[3]].map((c) => parseInt(c, 16)) as [number, number, number];
  return null;
}

/** WCAG 2 relative luminance of an sRGB colour */
export function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The contrast ratio of two hex colours, 1 to 21 */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) throw new Error(`Not a hex colour: ${ca ? b : a}`);
  const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The custom properties (`--name: value`) of each rule in a stylesheet, by
 * the rule's selector. Rules inside an at-rule are keyed "<at-rule> <selector>"
 * ("@media (prefers-color-scheme: dark) :root:not(...)"). Declarations of the
 * same selector are merged, later ones win. Only what tokens.css uses: no
 * nesting deeper than one at-rule.
 */
export function customProperties(css: string): Map<string, Record<string, string>> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = new Map<string, Record<string, string>>();
  const add = (selector: string, body: string) => {
    const props = rules.get(selector) ?? {};
    for (const decl of body.split(";")) {
      const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
      if (m) props[m[1]] = m[2].replace(/\s+/g, " ");
    }
    rules.set(selector, props);
  };
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    if (head.startsWith("@")) {
      // One level of nested rules, up to the at-rule's own closing brace
      let j = open + 1;
      for (;;) {
        const innerOpen = text.indexOf("{", j);
        const close = text.indexOf("}", j);
        if (close < 0) return rules;
        if (innerOpen < 0 || close < innerOpen) {
          i = close + 1;
          break;
        }
        const innerClose = text.indexOf("}", innerOpen);
        if (innerClose < 0) return rules;
        add(`${head} ${text.slice(j, innerOpen).trim()}`, text.slice(innerOpen + 1, innerClose));
        j = innerClose + 1;
      }
      continue;
    }
    const close = text.indexOf("}", open);
    if (close < 0) break;
    add(head, text.slice(open + 1, close));
    i = close + 1;
  }
  return rules;
}
