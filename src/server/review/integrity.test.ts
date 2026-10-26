/**
 * Test integrity check (docs/design/quality.md §1) over realistic diffs.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_FILE_KINDS } from "../policy/risk-rules.js";
import { DEFAULT_INTEGRITY_IGNORE } from "./config.js";
import { checkTestIntegrity, classifyAssertion, type IntegrityFile, type IntegrityOptions } from "./integrity.js";

const OPTIONS: IntegrityOptions = {
  testFiles: DEFAULT_FILE_KINDS.test,
  productionImports: [],
  ignore: DEFAULT_INTEGRITY_IGNORE,
};

/** A new file: its patch adds every line, and its content is those lines. */
function added(path: string, lines: string[]): IntegrityFile {
  return {
    path,
    previousPath: null,
    status: "added",
    patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`,
    content: lines.join("\n"),
  };
}

function modified(path: string, patch: string, content: string | null = null): IntegrityFile {
  return { path, previousPath: null, status: "modified", patch, content };
}

function rules(files: IntegrityFile[], options: IntegrityOptions = OPTIONS) {
  return checkTestIntegrity(files, options).map((f) => `${f.rule} ${f.file}:${f.line ?? "-"}`);
}

describe("self-asserting tests", () => {
  it("flags a test that only checks a fake it built, at the first assertion", () => {
    const findings = checkTestIntegrity(
      [
        added("src/billing/invoice.test.ts", [
          'import { describe, expect, it, vi } from "vitest";',
          'import { FakeLedger } from "../testing/fake-ledger";',
          'import type { Invoice } from "./invoice";',
          "",
          'describe("invoice", () => {',
          '  it("posts to the ledger", () => {',
          "    const ledger = new FakeLedger();",
          "    ledger.post({ amount: 5 });",
          "    expect(ledger.posted).toEqual([{ amount: 5 }]);",
          "    const invoice: Invoice = { id: 1 };",
          "    expect(invoice.id).toBe(1);",
          "  });",
          "});",
        ]),
      ],
      OPTIONS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "self-asserting-test",
      severity: "high",
      file: "src/billing/invoice.test.ts",
      line: 9,
    });
    expect(findings[0].text).toContain("2 assertion(s)");
    expect(findings[0].text).toContain("../testing/fake-ledger (test helper or fake)");
    expect(findings[0].text).toContain("./invoice (types only)");
  });

  it("does not flag a test that imports and calls the production module", () => {
    expect(
      rules([
        added("src/billing/invoice.test.ts", [
          'import { expect, it } from "vitest";',
          'import { totalOf } from "./invoice";',
          'it("totals", () => {',
          "  expect(totalOf([{ amount: 2 }, { amount: 3 }])).toBe(5);",
          "});",
        ]),
      ]),
    ).toEqual([]);
  });

  it("counts a production import that is never used, or replaced by a mock, as nothing wired in", () => {
    const unused = checkTestIntegrity(
      [
        added("src/api/users.test.ts", [
          'import { expect, it, vi } from "vitest";',
          'import { createUser } from "./users";',
          'it("creates", () => {',
          "  const repo = { save: vi.fn() };",
          "  repo.save({ name: 'a' });",
          "  expect(repo.save).toHaveBeenCalledWith({ name: 'a' });",
          "});",
        ]),
      ],
      OPTIONS,
    );
    expect(unused.map((f) => f.rule)).toEqual(["self-asserting-test"]);
    expect(unused[0].text).toContain("./users (production, imported but never used)");

    const mocked = checkTestIntegrity(
      [
        added("src/api/users.test.ts", [
          'import { expect, it, vi } from "vitest";',
          'import { createUser } from "./users";',
          'vi.mock("./users", () => ({ createUser: vi.fn(() => ({ id: 1 })) }));',
          'it("creates", () => {',
          "  expect(createUser()).toEqual({ id: 1 });",
          "});",
        ]),
      ],
      OPTIONS,
    );
    expect(mocked.map((f) => f.rule)).toEqual(["self-asserting-test"]);
    expect(mocked[0].text).toContain("./users (production, replaced by a mock)");
  });

  it("understands Python imports", () => {
    expect(
      rules([
        added("tests/test_orders.py", [
          "from unittest.mock import MagicMock",
          "",
          "def test_saves():",
          "    repo = MagicMock()",
          "    repo.save(1)",
          "    repo.save.assert_called_once_with(1)",
          "    assert repo.save.call_count == 1",
        ]),
      ]),
    ).toEqual(["self-asserting-test tests/test_orders.py:6"]);
    expect(
      rules([
        added("tests/test_orders.py", [
          "from app.orders import total",
          "",
          "def test_total():",
          "    assert total([2, 3]) == 5",
        ]),
      ]),
    ).toEqual([]);
  });

  it("leaves languages whose tests share a package with the code, and end-to-end suites, to the other checks", () => {
    expect(
      rules([
        added("pkg/orders/orders_test.go", [
          "package orders",
          'import "testing"',
          "func TestTotal(t *testing.T) {",
          "  if Total(2, 3) != 5 { t.Fatal() }",
          "}",
        ]),
        added("e2e/login.spec.ts", [
          'import { expect, test } from "vitest";',
          'test("logs in", () => {',
          "  expect(1).toBe(1);",
          "});",
        ]),
      ]),
    ).toEqual([]);
  });
});

describe("skipped and focused tests", () => {
  it("flags skips added to a test file, with their line", () => {
    const patch = [
      "@@ -10,6 +10,6 @@ describe(\"orders\", () => {",
      '   it("totals", () => {',
      "     expect(total([1])).toBe(1);",
      "   });",
      '-  it("refunds", () => {',
      '+  it.skip("refunds", () => {',
      "     expect(refund(1)).toBe(-1);",
      "   });",
    ].join("\n");
    expect(rules([modified("src/orders.test.ts", patch)])).toEqual(["skipped-test src/orders.test.ts:13"]);

    const python = ["@@ -1,2 +1,3 @@", " import pytest", "+@pytest.mark.skip(reason='flaky')", " def test_refund():"].join("\n");
    expect(rules([modified("tests/test_refund.py", python)])).toEqual(["skipped-test tests/test_refund.py:2"]);

    const focused = ["@@ -1,1 +1,1 @@", '-describe("orders", () => {', '+describe.only("orders", () => {'].join("\n");
    expect(rules([modified("src/orders.spec.ts", focused)])).toEqual(["focused-test src/orders.spec.ts:1"]);
  });

  it("does not flag a skip that only moved", () => {
    const patch = [
      "@@ -1,4 +1,4 @@",
      '-it.skip("legacy", () => {});',
      ' it("totals", () => {',
      " });",
      '+it.skip("legacy", () => {});',
    ].join("\n");
    expect(rules([modified("src/orders.test.ts", patch)])).toEqual([]);
  });
});

describe("weakened assertions", () => {
  it("flags an exact check replaced by an existence check", () => {
    const patch = [
      "@@ -20,3 +20,3 @@",
      "   const total = sum(items);",
      "-  expect(total).toBe(42);",
      "+  expect(total).toBeDefined();",
      "   expect(log).toHaveBeenCalledTimes(1);",
    ].join("\n");
    const findings = checkTestIntegrity([modified("src/sum.test.ts", patch)], OPTIONS);
    expect(findings).toEqual([
      expect.objectContaining({ rule: "assertion-weakened", file: "src/sum.test.ts", line: 21 }),
    ]);
    expect(findings[0].text).toContain("an exact check replaced by a truthiness check");
  });

  it("flags a call check losing its arguments, an assertEqual becoming assertTrue, and a widened tolerance", () => {
    const calls = ["@@ -5,1 +5,1 @@", "-  expect(send).toHaveBeenCalledWith(user, 'welcome');", "+  expect(send).toHaveBeenCalled();"].join("\n");
    const python = ["@@ -8,1 +8,1 @@", "-        self.assertEqual(result, 3)", "+        self.assertTrue(result)"].join("\n");
    const tolerance = ["@@ -3,1 +3,1 @@", "-  expect(ratio).toBeCloseTo(0.333, 5);", "+  expect(ratio).toBeCloseTo(0.333, 1);"].join("\n");
    expect(
      rules([
        modified("src/mail.test.ts", calls),
        modified("tests/test_calc.py", python),
        modified("src/ratio.test.ts", tolerance),
      ]),
    ).toEqual([
      "assertion-weakened src/mail.test.ts:5",
      "assertion-weakened tests/test_calc.py:8",
      "tolerance-widened src/ratio.test.ts:3",
    ]);
  });

  it("does not flag a stronger assertion, and reports assertions removed without replacement", () => {
    const stronger = ["@@ -2,1 +2,1 @@", "-  expect(user).toBeDefined();", "+  expect(user).toEqual({ id: 1 });"].join("\n");
    expect(rules([modified("src/user.test.ts", stronger)])).toEqual([]);

    const removed = [
      "@@ -2,3 +2,1 @@",
      "   const user = load(1);",
      "-  expect(user.id).toBe(1);",
      "-  expect(user.name).toBe('a');",
    ].join("\n");
    expect(rules([modified("src/user.test.ts", removed)])).toEqual(["assertion-removed src/user.test.ts:2"]);
  });

  it("ranks assertions from exact to truthiness", () => {
    expect(classifyAssertion("expect(x).toBe(1)")?.strength).toBe(3);
    expect(classifyAssertion("expect(x).toMatchObject({ a: 1 })")?.strength).toBe(2);
    expect(classifyAssertion("expect(x).not.toBeNull()")?.strength).toBe(1);
    expect(classifyAssertion("    assert result == 3")?.strength).toBe(3);
    expect(classifyAssertion("    assert result is not None")?.strength).toBe(1);
    expect(classifyAssertion("assertThat(total).isEqualTo(3);")?.strength).toBe(3);
    expect(classifyAssertion("// expect(x).toBe(1)")).toBeNull();
    expect(classifyAssertion("const x = 1;")).toBeNull();
  });
});

describe("removed tests, loosened suites and swallowed errors", () => {
  it("flags a deleted test file and removed test cases", () => {
    const deleted: IntegrityFile = {
      path: "src/payments.test.ts",
      previousPath: null,
      status: "removed",
      patch: null,
      content: null,
    };
    const cases = [
      "@@ -1,6 +1,2 @@",
      ' it("charges", () => {',
      " });",
      '-it("refunds", () => {',
      "-  expect(refund()).toBe(true);",
      "-});",
      "-",
    ].join("\n");
    expect(rules([deleted, modified("src/charge.test.ts", cases)])).toEqual([
      "test-removed src/payments.test.ts:-",
      "assertion-removed src/charge.test.ts:1",
      "test-removed src/charge.test.ts:3",
    ]);
  });

  it("does not block a test file that moved: every test case it had is in a test file the PR adds", () => {
    const removed: IntegrityFile = {
      path: "src/old/orders.test.ts",
      previousPath: null,
      status: "removed",
      patch: [
        "@@ -1,4 +0,0 @@",
        '-it("totals orders", () => {',
        "-  expect(total([1])).toBe(1);",
        "-});",
        '-test("refunds", () => {});',
      ].join("\n"),
      content: null,
    };
    const moved = added("src/orders/orders.test.ts", [
      'import { expect, it, test } from "vitest";',
      'import { total } from "./orders";',
      'it("totals orders", () => {',
      "  expect(total([1])).toBe(1);",
      "});",
      'test("refunds", () => expect(total([])).toBe(0));',
    ]);
    expect(checkTestIntegrity([removed, moved], OPTIONS)).toEqual([
      expect.objectContaining({ rule: "test-removed", severity: "low", file: "src/old/orders.test.ts" }),
    ]);

    const partial = added("src/orders/orders.test.ts", [
      'import { expect, it } from "vitest";',
      'import { total } from "./orders";',
      'it("totals orders", () => expect(total([1])).toBe(1));',
    ]);
    const lost = checkTestIntegrity([removed, partial], OPTIONS);
    expect(lost).toEqual([expect.objectContaining({ rule: "test-removed", severity: "high" })]);
    expect(lost[0].text).toContain("2 test case(s) (first: totals orders)");
  });

  it("flags exclusions added to a test config and a lowered coverage threshold", () => {
    const config = [
      "@@ -3,6 +3,7 @@ export default defineConfig({",
      "   test: {",
      '+    exclude: ["src/payments/**"],',
      "     coverage: {",
      "       thresholds: {",
      "-        lines: 80,",
      "+        lines: 60,",
      "       },",
    ].join("\n");
    const findings = checkTestIntegrity([modified("vitest.config.ts", config)], OPTIONS);
    expect(findings.map((f) => `${f.rule}:${f.line}`)).toEqual(["suite-loosened:4", "suite-loosened:7"]);
    expect(findings[1].text).toBe("Lowers a threshold: lines from 80 to 60.");
  });

  it("flags an error swallowed in test code", () => {
    const patch = [
      "@@ -4,2 +4,6 @@",
      ' it("loads", async () => {',
      "+  try {",
      "+    await load();",
      "+  } catch {}",
      "+  expect(true).toBe(true);",
      " });",
    ].join("\n");
    expect(rules([modified("src/load.test.ts", patch)])).toEqual(["error-swallowed src/load.test.ts:7"]);
  });

  it("ignores non-test files except test runner configs", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-  return a === b;", "+  return true; // it.skip( later"].join("\n");
    expect(rules([modified("src/compare.ts", patch)])).toEqual([]);
  });
});
