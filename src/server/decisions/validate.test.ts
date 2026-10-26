import { describe, expect, it } from "vitest";
import { NEVER_DEFAULT_KINDS } from "../../shared/decision-types.js";
import {
  hasControlCharacters,
  isDecisionId,
  isPrivateHost,
  parseAnswerInput,
  parseRaiseInput,
  parseWithdrawInput,
} from "./validate.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "demo",
    kind: "other",
    title: "Pick the default page size",
    context: "The list view needs a page size.",
    options: [
      { id: "small", label: "20 rows", consequences: "Faster pages, more paging." },
      { id: "large", label: "100 rows", consequences: "Slower pages, less paging." },
    ],
    recommended: { optionId: "small", reasoning: "Most lists are short." },
    source: { module: "planner", ref: "card-12" },
    key: "page-size",
    ...overrides,
  };
}

function errorsOf(raw: unknown): string[] {
  const parsed = parseRaiseInput(raw, NOW);
  return parsed.ok ? [] : parsed.errors;
}

describe("parseRaiseInput", () => {
  it("accepts a complete decision, applies defaults and normalises the expiry", () => {
    const parsed = parseRaiseInput(
      input({
        blocks: ["card-12", "card-13", "card-12"],
        expiresAt: "2026-03-02T15:00:00+02:00",
        defaultOptionId: "small",
        links: [{ label: "Design", url: "https://example.com/design#page-size" }],
      }),
      NOW,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      project: "demo",
      kind: "other",
      blocks: ["card-12", "card-13"],
      expiresAt: "2026-03-02T13:00:00.000Z",
      defaultOptionId: "small",
      links: [{ label: "Design", url: "https://example.com/design#page-size" }],
    });
  });

  it("refuses an expiry that is not in the future, and a default without an expiry", () => {
    expect(errorsOf(input({ expiresAt: "2026-03-02T12:00:00Z" }))).toEqual(["expiresAt: must be in the future"]);
    expect(errorsOf(input({ expiresAt: "tomorrow" }))[0]).toContain("expiresAt");
    expect(errorsOf(input({ defaultOptionId: "small" }))).toEqual([
      "defaultOptionId: a default applies at expiry, so it needs expiresAt",
    ]);
    expect(
      errorsOf(input({ expiresAt: "2026-03-02T13:00:00Z", defaultOptionId: "medium" })),
    ).toEqual(["defaultOptionId: must be one of the options"]);
  });

  it("refuses a default for every kind that always waits", () => {
    for (const kind of NEVER_DEFAULT_KINDS) {
      const extra =
        kind === "credentials"
          ? {
              secretName: "API_TOKEN",
              options: [
                { id: "supply", label: "Enter it", consequences: "Stored.", suppliesSecret: true },
                { id: "later", label: "Later", consequences: "Stays blocked." },
              ],
              recommended: { optionId: "supply", reasoning: "Needed." },
              defaultOptionId: "later",
            }
          : { defaultOptionId: "small" };
      expect(errorsOf(input({ kind, expiresAt: "2026-03-02T13:00:00Z", ...extra }))).toEqual([
        `defaultOptionId: ${kind} decisions can't have a default: they always wait for a human`,
      ]);
    }
    expect(NEVER_DEFAULT_KINDS).toEqual(
      expect.arrayContaining(["spend", "credentials", "legal", "pricing", "account", "go_no_go"]),
    );
  });

  it("rejects unknown keys, unknown kinds and bad shapes, naming the field", () => {
    expect(errorsOf(input({ deafultOptionId: "small" }))[0]).toContain("deafultOptionId");
    expect(errorsOf(input({ kind: "whatever" }))[0]).toMatch(/^kind: /);
    expect(errorsOf(input({ options: [] }))[0]).toMatch(/^options: /);
    expect(errorsOf(input({ project: "../etc" }))[0]).toMatch(/^project: /);
    expect(errorsOf(input({ source: { module: "Not A Module", ref: "x" } }))[0]).toMatch(/^source\.module: /);
    expect(errorsOf(undefined)[0]).toMatch(/^project: /);
  });

  it("checks the options against each other and the recommendation", () => {
    const options = [
      { id: "same", label: "One", consequences: "A." },
      { id: "same", label: "Two", consequences: "B." },
    ];
    expect(errorsOf(input({ options, recommended: { optionId: "same", reasoning: "r" } }))).toEqual([
      "options: duplicate option id same",
    ]);
    expect(errorsOf(input({ recommended: { optionId: "missing", reasoning: "r" } }))).toEqual([
      "recommended.optionId: must be one of the options",
    ]);
    expect(errorsOf(input({ options: [{ id: "Bad Id", label: "x", consequences: "y" }] }))[0]).toMatch(
      /^options\.0\.id: /,
    );
  });

  it("keeps titles to one line and text free of control characters", () => {
    expect(errorsOf(input({ title: "two\nlines" }))[0]).toBe("title: must be one line without control characters");
    expect(errorsOf(input({ context: "colour \u001b[31mred" }))[0]).toBe(
      "context: must not contain control characters",
    );
    expect(errorsOf(input({ context: "line one\nline two\ttabbed" }))).toEqual([]);
    expect(errorsOf(input({ title: "x".repeat(201) }))[0]).toMatch(/^title: /);
  });

  it("only allows http(s) links", () => {
    expect(errorsOf(input({ links: [{ label: "x", url: "javascript:alert(1)" }] }))).toEqual([
      "links.0.url: must be an http or https URL",
    ]);
  });

  it("refuses links to this machine or a private network, however the address is written", () => {
    const refused = [
      "http://localhost:9999/answer",
      "http://LOCALHOST./x",
      "http://agent.localhost/",
      "http://printer.local/",
      "http://intranet/",
      "http://127.0.0.1:3000/",
      "http://127.1.2.3/",
      "http://0x7f.1/",
      "http://2130706433/",
      "http://0.0.0.0/",
      "http://10.1.2.3/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.10/",
      "http://169.254.169.254/latest",
      "http://100.64.0.1/",
      "http://[::1]:4777/",
      "http://[::]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:10.0.0.1]/",
    ];
    for (const url of refused) {
      expect([url, errorsOf(input({ links: [{ label: "x", url }] }))[0]]).toEqual([
        url,
        expect.stringContaining("links.0.url: must not point at this machine or a private network"),
      ]);
    }
    for (const url of [
      "https://example.com/plan",
      "http://198.51.100.7/",
      "http://172.32.0.1/",
      "http://[2001:db8::1]/",
      "https://docs.example.org:8443/a?b#c",
    ]) {
      expect([url, errorsOf(input({ links: [{ label: "x", url }] }))]).toEqual([url, []]);
    }
  });

  it("recognises private hosts", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("[::1]")).toBe(true);
    expect(isPrivateHost("[::ffff:7f00:1]")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("203.0.113.9")).toBe(false);
  });

  it("ties secrets to credentials decisions", () => {
    expect(errorsOf(input({ kind: "credentials" }))).toEqual([
      "secretName: a credentials decision needs the name its secret is stored under",
      "options: a credentials decision needs an option with suppliesSecret: true",
    ]);
    expect(errorsOf(input({ secretName: "API_TOKEN" }))).toEqual([
      "secretName: only credentials decisions take a secret",
    ]);
    const supplying = [{ id: "supply", label: "Enter it", consequences: "Stored.", suppliesSecret: true }];
    expect(
      errorsOf(input({ options: supplying, recommended: { optionId: "supply", reasoning: "r" } })),
    ).toEqual(["options: only credentials decisions have options that supply a secret"]);
  });
});

describe("parseAnswerInput and parseWithdrawInput", () => {
  it("accepts an answer and drops an empty note", () => {
    expect(parseAnswerInput({ optionId: "small", note: "  " })).toEqual({ ok: true, value: { optionId: "small" } });
    expect(parseAnswerInput({ optionId: "small", note: "ok", confirm: true })).toEqual({
      ok: true,
      value: { optionId: "small", note: "ok", confirm: true },
    });
    // Who answered is decided by the server, never the request
    expect(parseAnswerInput({ optionId: "small", by: "someone-else" }).ok).toBe(false);
  });

  it("rejects unknown keys without repeating their values", () => {
    const parsed = parseAnswerInput({ optionId: "supply", secrets: "do-not-echo-this-value" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("secrets");
    expect(parsed.errors.join(" ")).not.toContain("do-not-echo-this-value");
    const wrongType = parseAnswerInput({ optionId: "supply", secret: 42 });
    expect(wrongType.ok).toBe(false);
  });

  it("needs a module and a reason to withdraw", () => {
    expect(parseWithdrawInput({ module: "planner", reason: "done another way" }).ok).toBe(true);
    const parsed = parseWithdrawInput({ module: "planner" });
    expect(parsed.ok).toBe(false);
  });
});

describe("helpers", () => {
  it("recognises decision ids", () => {
    expect(isDecisionId("0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b")).toBe(true);
    expect(isDecisionId("../../etc/passwd")).toBe(false);
    expect(isDecisionId("summary")).toBe(false);
    expect(isDecisionId(undefined)).toBe(false);
  });

  it("finds control characters", () => {
    expect(hasControlCharacters("plain", false)).toBe(false);
    expect(hasControlCharacters("a\nb", false)).toBe(true);
    expect(hasControlCharacters("a\nb", true)).toBe(false);
    expect(hasControlCharacters("a\u007fb", true)).toBe(true);
  });
});
