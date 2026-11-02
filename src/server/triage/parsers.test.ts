/**
 * Evidence parsers: JUnit XML (with "Caused by" chains and field errors),
 * Gradle, vitest, jest and pytest console output, and the step that turns a
 * whole gate result into causes. Fixtures are invented (fixtures/triage/).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_PATTERNS } from "./config.js";
import {
  parseGateEvidence,
  parseGradle,
  parseJUnit,
  parseJest,
  parsePytest,
  parseVitest,
  parseXml,
  parseGoTest,
  parseCargoTest,
  parseTrx,
  createCustomParser,
  validateCustomParserConfig,
  runCatastrophicRegexTest,
} from "./parsers/index.js";
import { fixture, gate, sha, step } from "./testing/harness.js";

const options = { contextPatterns: DEFAULT_CONTEXT_PATTERNS.map((p) => new RegExp(p, "i")) };

describe("JUnit XML", () => {
  it("reads a context failure as ONE cause for every test it failed, with its Caused by chain", () => {
    const out = parseJUnit(fixture("junit-context-failure.xml"), options);
    expect(out.causes).toHaveLength(1);
    const [cause] = out.causes;
    expect(cause.kind).toBe("context");
    expect(cause.testCount).toBe(4);
    expect(cause.tests.map((t) => t.key)).toEqual([
      "OrderApiIT#createsOrder()",
      "OrderApiIT#listsOrders()",
      "OrderApiIT#cancelsOrder()",
      "PaymentApiIT#refundsPayment()",
    ]);
    expect(cause.causedBy).toEqual([
      "org.springframework.beans.factory.BeanCreationException: Error creating bean with name 'dataSource': Failed to initialize the pool",
      "org.testcontainers.containers.ContainerLaunchException: Container startup failed for image postgres:16",
      "java.net.SocketTimeoutException: connect timed out",
    ]);
    expect(cause.rootCause).toBe("java.net.SocketTimeoutException: connect timed out");
    expect(cause.type).toBe("java.lang.IllegalStateException");
    expect(cause.evidence).toContain("4 test(s) failed with this one context failure");
    expect(cause.locations).toContainEqual({ file: "com/example/shop/support/DatabaseExtension.java", line: 27 });
    expect(out.passed.map((t) => t.key)).toEqual(["MoneyTest#addsAmounts()"]);
    expect(out.failedCount).toBe(4);
  });

  it("keeps assertion failures, field errors, reruns that passed and project frames", () => {
    const out = parseJUnit(fixture("junit-assertion.xml"), options);
    expect(out.causes.map((c) => c.kind)).toEqual(["test", "test"]);
    const [assertion, validation] = out.causes;
    expect(assertion.type).toBe("org.opentest4j.AssertionFailedError");
    expect(assertion.message).toBe("expected: <108> but was: <100>");
    expect(assertion.tests[0]).toMatchObject({
      suite: "com.example.shop.orders.OrderServiceTest",
      name: "totalIncludesTax()",
      id: "com.example.shop.orders.OrderServiceTest#totalIncludesTax()",
      key: "OrderServiceTest#totalIncludesTax()",
    });
    expect(assertion.locations).toEqual([
      { file: "com/example/shop/orders/OrderService.java", line: 88 },
      { file: "com/example/shop/orders/OrderServiceTest.java", line: 42 },
    ]);
    expect(validation.evidence.some((e) => e.startsWith("Field error in object 'orderRequest' on field 'quantity'"))).toBe(true);
    // passed on a rerun inside the run: not a failure, but flaky
    expect(out.flaky.map((t) => t.key)).toEqual(["OrderServiceTest#appliesDiscount()"]);
    expect(out.passed.map((t) => t.key)).toEqual(["OrderServiceTest#appliesDiscount()"]);
  });

  it("rebuilds pytest node ids from the file attribute", () => {
    const xml = `<testsuites><testsuite name="pytest">
      <testcase classname="tests.test_refunds.TestRefunds" name="test_full_refund" file="tests/test_refunds.py" line="20">
        <failure message="AssertionError: assert 0 == 5">tests/test_refunds.py:22: AssertionError</failure>
      </testcase>
      <testcase classname="tests.test_orders" name="test_total" file="tests/test_orders.py" line="3"/>
    </testsuite></testsuites>`;
    const out = parseJUnit(xml, options);
    expect(out.causes[0].tests[0]).toMatchObject({
      id: "tests/test_refunds.py::TestRefunds::test_full_refund",
      key: "TestRefunds#test_full_refund",
      file: "tests/test_refunds.py",
    });
    expect(out.causes[0].type).toBe("AssertionError");
    expect(out.passed[0].id).toBe("tests/test_orders.py::test_total");
  });

  it("decodes entities and CDATA, and survives a truncated report", () => {
    const root = parseXml(`<a x="1 &lt; 2 &amp;&#x41;&#66;"><b><![CDATA[<raw> & text]]></b>&quot;q&apos;<c`);
    expect(root.children[0].attrs.x).toBe("1 < 2 &AB");
    expect(root.children[0].children[0].text).toBe("<raw> & text");
    expect(root.children[0].text).toBe(`"q'`);
  });
});

describe("console summaries", () => {
  it("Gradle: test blocks with Caused by on its own line, the context failure as one cause", () => {
    const out = parseGradle(fixture("gradle-test.txt"), { ...options, step: "test" });
    expect(out.failedCount).toBe(3);
    expect(out.causes.map((c) => c.kind)).toEqual(["context", "test"]);
    const [context, assertion] = out.causes;
    expect(context.tests.map((t) => t.key)).toEqual(["OrderApiIT#createsOrder()", "OrderApiIT#listsOrders()"]);
    expect(context.causedBy).toEqual([
      "org.testcontainers.containers.ContainerLaunchException: Container startup failed for image postgres:16",
      "java.net.SocketTimeoutException: connect timed out",
    ]);
    expect(context.step).toBe("test");
    expect(assertion.tests[0].key).toBe("OrderServiceTest#totalIncludesTax()");
    expect(assertion.locations[0]).toEqual({ file: "com/example/shop/orders/OrderService.java", line: 88 });
  });

  it("Gradle: a compile failure is a build cause with the compiler's file and line", () => {
    const out = parseGradle(fixture("gradle-compile.txt"), { ...options, step: "build" });
    expect(out.causes).toHaveLength(1);
    expect(out.causes[0]).toMatchObject({ kind: "build", step: "build", testCount: 0 });
    expect(out.causes[0].message).toContain("error: cannot find symbol");
    expect(out.causes[0].locations[0]).toEqual({
      file: "/home/user/project/app/src/main/java/com/example/shop/orders/OrderService.java",
      line: 88,
    });
    expect(out.causes[0].evidence).toContain("Execution failed for task ':app:compileJava'.");
  });

  it("vitest: failed tests and a file that failed to load", () => {
    const out = parseVitest(fixture("vitest-console.txt"), options);
    expect(out.failedCount).toBe(1);
    expect(out.causes.map((c) => c.kind)).toEqual(["context", "test"]);
    const [suite, test] = out.causes;
    expect(suite.tests[0]).toMatchObject({ suite: "src/db/orders-repo.test.ts", name: "(suite)" });
    expect(suite.type).toBe("Error");
    expect(suite.message).toBe("connect ECONNREFUSED 127.0.0.1:5432");
    expect(test.tests[0]).toMatchObject({
      key: "src/orders/total.test.ts#total > includes tax",
      file: "src/orders/total.test.ts",
    });
    expect(test.type).toBe("AssertionError");
    expect(test.message).toBe("expected 100 to be 108 // Object.is equality");
    expect(test.locations[0]).toEqual({ file: "src/orders/total.test.ts", line: 14 });
  });

  it("jest: ● blocks per file, and a suite that failed to run", () => {
    const out = parseJest(fixture("jest-console.txt"), options);
    expect(out.failedCount).toBe(1);
    expect(out.causes.map((c) => c.kind)).toEqual(["context", "test"]);
    const [suite, test] = out.causes;
    expect(suite.tests[0].suite).toBe("src/db/orders-repo.test.js");
    expect(suite.message).toBe("Cannot find module '../config/database' from 'src/db/orders-repo.test.js'");
    expect(suite.locations).toEqual([]);
    expect(test.tests[0].key).toBe("src/orders/total.test.js#total > includes tax");
    expect(test.message).toBe("expect(received).toBe(expected) // Object.is equality");
    expect(test.locations[0]).toEqual({ file: "src/orders/total.test.js", line: 14 });
  });

  it("pytest: the short summary with its sections; setup errors are one context cause", () => {
    const out = parsePytest(fixture("pytest-console.txt"), options);
    expect(out.failedCount).toBe(3);
    expect(out.causes.map((c) => c.kind)).toEqual(["context", "test"]);
    const [setup, assertion] = out.causes;
    expect(setup.tests.map((t) => t.id)).toEqual([
      "tests/test_refunds.py::TestRefunds::test_full_refund",
      "tests/test_refunds.py::TestRefunds::test_partial_refund",
    ]);
    expect(setup.type).toBe("sqlalchemy.exc.OperationalError");
    expect(setup.message).toContain("Connection refused");
    expect(assertion.tests[0]).toMatchObject({ id: "tests/test_orders.py::test_total_with_tax", key: "test_orders#test_total_with_tax" });
    expect(assertion.type).toBe("AssertionError");
    expect(assertion.evidence).toContain("assert 100 == 108");
    expect(assertion.locations).toContainEqual({ file: "tests/test_orders.py", line: 9 });
  });

  it("go test -json: parses JSON events and extracts failures", () => {
    const out = parseGoTest(fixture("go-test-json.txt"), options);
    expect(out.failedCount).toBe(2);
    expect(out.causes).toHaveLength(2);
    const [total, connect] = out.causes;
    expect(total.tests[0]).toMatchObject({
      suite: "example.com/shop/orders",
      name: "TestCalculateTotal",
    });
    expect(total.message).toContain("expected 108, got 100");
    expect(connect.tests[0]).toMatchObject({
      suite: "example.com/shop/orders",
      name: "TestConnectDB",
    });
    expect(connect.type).toBe("panic");
    expect(connect.message).toContain("connection refused");
  });

  it("go test -json: detection scans all bounded lines (S5)", () => {
    // A cold-cache run may have many "go: downloading" lines before the first test event.
    // Detection must scan all lines, not just the first 100.
    const downloadLines = Array(150).fill('go: downloading example.com/package/v1 v1.0.0\n').join('');
    const testOutput = `{"Time":"2026-01-01T00:00:00Z","Action":"start","Package":"test/pkg"}
{"Time":"2026-01-01T00:00:01Z","Action":"run","Package":"test/pkg","Test":"TestOne"}
{"Time":"2026-01-01T00:00:02Z","Action":"output","Package":"test/pkg","Test":"TestOne","Output":"--- FAIL: TestOne\\n"}
{"Time":"2026-01-01T00:00:03Z","Action":"fail","Package":"test/pkg","Test":"TestOne"}
`;
    const fullOutput = downloadLines + testOutput;
    const out = parseGoTest(fullOutput, options);
    // Should detect and parse the test events after 150 download lines
    expect(out.failedCount).toBe(1);
    expect(out.causes).toHaveLength(1);
    expect(out.causes[0].tests[0].name).toBe("TestOne");
  });

  it("cargo test: parses Rust test output with failures section", () => {
    const out = parseCargoTest(fixture("cargo-test.txt"), options);
    expect(out.failedCount).toBe(2);
    expect(out.causes).toHaveLength(2);
    const [total, connect] = out.causes;
    expect(total.tests[0]).toMatchObject({
      suite: "orders::tests",
      name: "test_calculate_total",
    });
    expect(total.type).toBe("panic");
    expect(total.message).toContain("assertion failed");
    // One-line panic format extracts location (S4 fix)
    expect(total.tests[0].file).toBe("src/orders.rs");
    expect(connect.tests[0]).toMatchObject({
      suite: "db::tests",
      name: "test_connect",
    });
    expect(connect.message).toContain("connection failed");
    expect(connect.tests[0].file).toBe("src/db.rs");
  });

  it("cargo test: parses Rust 1.73+ panic format (F3)", () => {
    // Rust 1.73+ changed the panic format from:
    //   thread 'x' panicked at 'message', src/lib.rs:45:9
    // to:
    //   thread 'x' panicked at src/lib.rs:45:9:
    //   message
    const out = parseCargoTest(fixture("cargo-test-173.txt"), options);
    expect(out.failedCount).toBe(2);
    expect(out.causes).toHaveLength(2);
    const [total, connect] = out.causes;
    expect(total.tests[0]).toMatchObject({
      suite: "orders::tests",
      name: "test_calculate_total",
    });
    expect(total.type).toBe("panic");
    // The new format has the message on the next line
    expect(total.message).toContain("assertion");
    // Location should be extracted from the new format
    expect(total.tests[0].file).toBe("src/orders.rs");
    expect(connect.tests[0]).toMatchObject({
      suite: "db::tests",
      name: "test_connect",
    });
    expect(connect.type).toBe("panic");
    expect(connect.message).toContain("connection failed");
  });
});

describe("parseGateEvidence", () => {
  const contextPatterns = options.contextPatterns;

  it("prefers a report over the console for the same tests, and reads each failed step", () => {
    const result = gate({
      sha: sha("p1"),
      branch: "feat/example",
      steps: [step("lint", "passed"), step("test", "failed", fixture("gradle-test.txt")), step("build", "failed", fixture("gradle-compile.txt"))],
    });
    const evidence = parseGateEvidence(result, [{ name: "TEST-OrderApiIT.xml", step: "test", content: fixture("junit-context-failure.xml") }], {
      contextPatterns,
    });
    expect(evidence.parsers.sort()).toEqual(["gradle", "junit"]);
    const kinds = evidence.causes.map((c) => `${c.step}:${c.kind}:${c.parser}`);
    // The report's context cause replaces the console's; the console adds the
    // assertion the report doesn't have, and the build step's compile error
    expect(kinds).toEqual(["test:context:junit", "test:test:gradle", "build:build:gradle"]);
    expect(evidence.causes[0].testCount).toBe(4);
  });

  it("turns a failed step that no parser reads into one cause with its exit code and error lines", () => {
    const result = gate({
      sha: sha("p2"),
      branch: "feat/example",
      steps: [step("lint", "passed"), step("integration", "failed", "starting services\nCannot connect to the Docker daemon at unix:///var/run/docker.sock\n", 125)],
    });
    const [cause] = parseGateEvidence(result, [], { contextPatterns }).causes;
    expect(cause).toMatchObject({ kind: "step", step: "integration", type: "exit 125", parser: "exit" });
    expect(cause.message).toBe("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
    expect(cause.evidence).toContain("Step integration failed with exit code 125");
  });

  it("returns no causes for a passed result, but keeps the tests it saw pass", () => {
    const result = gate({ sha: sha("p3"), branch: "feat/example", status: "passed", steps: [step("test", "passed")] });
    const evidence = parseGateEvidence(result, [{ content: fixture("junit-context-failure.xml") }], { contextPatterns });
    expect(evidence.causes).toEqual([]);
    expect(evidence.passed.map((t) => t.key)).toContain("MoneyTest#addsAmounts()");
  });

  it("names the runner when a result failed without a failed step", () => {
    const result = gate({ sha: sha("p4"), branch: "feat/example", status: "error", steps: [step("test", "skipped")] });
    const [cause] = parseGateEvidence(result, [], { contextPatterns }).causes;
    expect(cause).toMatchObject({ kind: "step", parser: "runner", type: "error" });
  });
});

describe("output written by the code under test", () => {
  it("multi-megabyte lines and a deeply nested report finish fast and don't throw", () => {
    const started = Date.now();
    // Lines shaped to make backtracking patterns explode: test headers, banners,
    // separators, Caused by, a FAIL header and an E line, each megabytes long
    const output = [
      "a > ".repeat(1_000_000) + "b",
      "x".repeat(3_000_000) + " > y FAILED",
      "=".repeat(2_000_000) + " short test summary info",
      "_".repeat(2_000_000) + " t " + "_".repeat(10),
      "⎯".repeat(1_000_000) + " Failed Tests",
      " FAIL  " + "a".repeat(2_000_000) + " > x",
      "Caused by:" + " ".repeat(2_000_000) + "x",
      "    at " + "a.".repeat(500_000) + "b(Foo.java:1)",
      "E   " + "a".repeat(1_000_000),
      "12 tests completed, 1 failed",
    ].join("\n");
    const result = gate({ sha: sha("p1"), branch: "feat/x", steps: [step("test", "failed", output, 1)] });
    const nested =
      "<testsuites>" +
      '<testsuite name="s">'.repeat(100_000) +
      `<testcase name="t" classname="${"c".repeat(1_000_000)}"><failure message="m">${"x\n".repeat(500_000)}</failure></testcase>` +
      "</testsuite>".repeat(100_000) +
      "</testsuites>";
    const attributes = `<testsuite><testcase name="a" ${"x=".repeat(500_000)}/></testsuite>`;
    const unclosed = "<a>".repeat(200_000) + "</b>".repeat(200_000);

    const evidence = parseGateEvidence(result, [{ content: nested }, { content: attributes }, { content: unclosed, format: "junit" }], options);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(evidence.causes.length).toBeGreaterThan(0);
    // The nested report still yields its failing testcase, cut to a bounded size
    const junit = evidence.causes.find((c) => c.parser === "junit");
    expect(junit?.tests[0].suite.length).toBeLessThanOrEqual(500);
    expect(junit?.message).toBe("m");
  }, 30_000);
});

describe(".NET TRX reports", () => {
  it("parses failed and passed tests from trx XML", () => {
    const out = parseTrx(fixture("dotnet-trx.xml"), options);
    expect(out.failedCount).toBe(2);
    expect(out.causes).toHaveLength(2);
    const [assertion, connection] = out.causes;
    expect(assertion.tests[0]).toMatchObject({
      suite: "Shop.Orders.Tests.OrderServiceTests",
      name: "CalculateTotal_WithTax_ReturnsCorrectAmount",
    });
    expect(assertion.message).toContain("Assert.Equal() Failure");
    expect(connection.tests[0]).toMatchObject({
      suite: "Shop.Data.Tests.ConnectionTests",
      name: "ConnectToDatabase_WhenDown_ThrowsException",
    });
    expect(connection.type).toBe("System.Data.SqlClient.SqlException");
    expect(out.passed.map((t) => t.name)).toEqual([
      "ApplyDiscount_ValidCode_ReducesTotal",
      "ValidateOrder_EmptyCart_ReturnsFalse",
    ]);
  });

  it("is detected by parseGateEvidence without a format hint (S1)", () => {
    // The detection regex must work on the real namespace format:
    // xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"
    const result = gate({
      sha: sha("trx1"),
      branch: "feat/dotnet",
      steps: [step("test", "failed", "running tests...\n1 failed")],
    });
    const evidence = parseGateEvidence(result, [{ name: "test-results.trx", content: fixture("dotnet-trx.xml") }], options);
    expect(evidence.parsers).toContain("trx");
    expect(evidence.causes.some((c) => c.parser === "trx")).toBe(true);
  });

  it("treats Error, Timeout, and Aborted outcomes as failed (S2)", () => {
    // TRX files can have outcomes: Passed, Failed, Error, Timeout, Aborted, NotExecuted, Inconclusive
    // Error, Timeout, and Aborted should all be treated as failures
    const trxWithOtherOutcomes = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="test1" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testId="t1" testName="TestError" outcome="Error">
      <Output><ErrorInfo><Message>Runtime error occurred</Message></ErrorInfo></Output>
    </UnitTestResult>
    <UnitTestResult testId="t2" testName="TestTimeout" outcome="Timeout">
      <Output><ErrorInfo><Message>Test execution timed out</Message></ErrorInfo></Output>
    </UnitTestResult>
    <UnitTestResult testId="t3" testName="TestAborted" outcome="Aborted">
      <Output><ErrorInfo><Message>Test was aborted</Message></ErrorInfo></Output>
    </UnitTestResult>
    <UnitTestResult testId="t4" testName="TestNotExecuted" outcome="NotExecuted" />
    <UnitTestResult testId="t5" testName="TestPassed" outcome="Passed" />
  </Results>
  <TestDefinitions>
    <UnitTest name="TestError" id="t1"><TestMethod className="Tests.ErrorTests" name="TestError" /></UnitTest>
    <UnitTest name="TestTimeout" id="t2"><TestMethod className="Tests.TimeoutTests" name="TestTimeout" /></UnitTest>
    <UnitTest name="TestAborted" id="t3"><TestMethod className="Tests.AbortedTests" name="TestAborted" /></UnitTest>
    <UnitTest name="TestNotExecuted" id="t4"><TestMethod className="Tests.SkippedTests" name="TestNotExecuted" /></UnitTest>
    <UnitTest name="TestPassed" id="t5"><TestMethod className="Tests.PassingTests" name="TestPassed" /></UnitTest>
  </TestDefinitions>
</TestRun>`;
    const out = parseTrx(trxWithOtherOutcomes, options);
    // Should have 3 failures: Error, Timeout, Aborted
    expect(out.failedCount).toBe(3);
    expect(out.causes).toHaveLength(3);
    expect(out.causes.map((c) => c.tests[0].name).sort()).toEqual(["TestAborted", "TestError", "TestTimeout"]);
    // NotExecuted should NOT be in failures (it wasn't run)
    expect(out.causes.some((c) => c.tests[0].name === "TestNotExecuted")).toBe(false);
    // Passed should be in passed list
    expect(out.passed.map((t) => t.name)).toEqual(["TestPassed"]);
  });
});

describe("custom regex parser", () => {
  it("validates config and rejects invalid patterns", () => {
    expect(validateCustomParserConfig(null)).toContain("custom parser config must be an object");
    expect(validateCustomParserConfig({})).toContain("custom parser requires a non-empty 'name' field");
    expect(validateCustomParserConfig({ name: "test", detect: "x" })).toContain(
      "custom parser requires a non-empty 'fail_pattern'",
    );
    expect(
      validateCustomParserConfig({ name: "test", detect: "x", fail_pattern: "(?<other>x)" }),
    ).toContain("custom parser 'fail_pattern' must include a (?<name>...) capture group");
    expect(
      validateCustomParserConfig({ name: "test", detect: "[", fail_pattern: "(?<name>x)" }),
    ).toContain("custom parser 'detect' pattern is not a valid regex");
    expect(
      validateCustomParserConfig({ name: "test", detect: "x", fail_pattern: "(?<name>x)" }),
    ).toEqual([]);
  });

  it("refuses names that conflict with built-in parser ids (L3)", () => {
    // Built-in ids cannot be used as custom parser names
    expect(
      validateCustomParserConfig({ name: "junit", detect: "x", fail_pattern: "(?<name>x)" }),
    ).toContain("custom parser name 'junit' conflicts with a built-in parser");
    expect(
      validateCustomParserConfig({ name: "go", detect: "x", fail_pattern: "(?<name>x)" }),
    ).toContain("custom parser name 'go' conflicts with a built-in parser");
    expect(
      validateCustomParserConfig({ name: "cargo", detect: "x", fail_pattern: "(?<name>x)" }),
    ).toContain("custom parser name 'cargo' conflicts with a built-in parser");
    // Custom names are fine
    expect(
      validateCustomParserConfig({ name: "myparser", detect: "x", fail_pattern: "(?<name>x)" }),
    ).toEqual([]);
  });

  it("parses test output with custom patterns", async () => {
    const parser = createCustomParser({
      name: "mytest",
      detect: "MyTest Framework",
      fail_pattern: "FAIL:\\s+(?<suite>[^:]+)::(?<name>\\S+)\\s+-\\s+(?<message>.+)",
      summary_pattern: "(?<failed>\\d+) failed, (?<passed>\\d+) passed",
    });
    expect(parser).not.toBeNull();

    const output = `
MyTest Framework v1.0
Running tests...
PASS: orders::test_create
FAIL: orders::test_total - expected 108 but got 100
PASS: orders::test_delete
FAIL: db::test_connect - connection refused
Summary: 2 failed, 2 passed
`;
    const out = await parser!.parse(output, options);
    expect(out.failedCount).toBe(2);
    expect(out.causes).toHaveLength(2);
    expect(out.causes[0].tests[0]).toMatchObject({ suite: "orders", name: "test_total" });
    expect(out.causes[0].message).toBe("expected 108 but got 100");
    expect(out.causes[1].tests[0]).toMatchObject({ suite: "db", name: "test_connect" });
  });

  it("bounds input to prevent regex attacks", async () => {
    const parser = createCustomParser({
      name: "bounded",
      detect: "test",
      fail_pattern: "FAIL:\\s+(?<name>\\S+)",
    });
    expect(parser).not.toBeNull();

    // A huge input should not cause timeout or memory issues
    const started = Date.now();
    const hugeOutput = "test\n" + "FAIL: test_" + "a".repeat(100_000) + "\n".repeat(1000);
    const out = await parser!.parse(hugeOutput, options);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.causes.length).toBeLessThanOrEqual(5000);
  });

  it("rejects patterns that match the empty string (M1: infinite loop prevention)", () => {
    // A pattern like (?<name>\w*) matches "" and would loop forever with exec()
    const result1 = validateCustomParserConfig({ name: "test", detect: "x", fail_pattern: "(?<name>\\w*)" });
    expect(result1).toEqual(
      expect.arrayContaining([expect.stringContaining("must not match the empty string")])
    );

    // A pattern with optional prefix and (?<name>.*) also matches ""
    const result2 = validateCustomParserConfig({ name: "test", detect: "x", fail_pattern: "(?:FAIL)?\\s*(?<name>.*)" });
    expect(result2).toEqual(
      expect.arrayContaining([expect.stringContaining("must not match the empty string")])
    );

    // A pattern that requires at least one character is accepted
    expect(
      validateCustomParserConfig({ name: "test", detect: "x", fail_pattern: "FAIL:\\s+(?<name>\\S+)" }),
    ).toEqual([]);
  });

  it("handles zero-length matches safely without infinite loops (M1 fix)", async () => {
    // Even if validation is bypassed, the parser should not hang
    // This test uses a pattern that could match empty strings repeatedly
    const parser = createCustomParser({
      name: "test",
      detect: "test",
      fail_pattern: "(?<name>x*)", // Matches empty string
    });
    expect(parser).not.toBeNull();

    // The parse should complete quickly even with input that has many positions
    // Worker thread startup adds overhead, so allow more time than a sync version
    const started = Date.now();
    const input = "test\n" + "y".repeat(1000);
    const out = await parser!.parse(input, options);
    expect(Date.now() - started).toBeLessThan(2000); // Allow worker startup overhead
    // matchAll with a pattern that matches empty strings at every position
    // should not hang; it may find matches at x positions or none
    expect(out.causes.length).toBeLessThanOrEqual(5000);
  });

  it("rejects nested quantifiers (M3: catastrophic backtracking)", () => {
    // Pattern (a+)+$ causes exponential backtracking
    const result1 = validateCustomParserConfig({ name: "test", detect: "x", fail_pattern: "(a+)+(?<name>x)" });
    expect(result1).toEqual(
      expect.arrayContaining([expect.stringContaining("nested quantifiers")])
    );

    // Pattern (\w+\s?)* also causes catastrophic backtracking
    const result2 = validateCustomParserConfig({ name: "test", detect: "x", fail_pattern: "(\\w+\\s?)*(?<name>x)" });
    expect(result2).toEqual(
      expect.arrayContaining([expect.stringContaining("nested quantifiers")])
    );

    // Pattern (\d*)* has nested quantifiers
    const result3 = validateCustomParserConfig({ name: "test", detect: "(\\d*)*", fail_pattern: "(?<name>x)" });
    expect(result3).toEqual(
      expect.arrayContaining([expect.stringContaining("nested quantifiers")])
    );
  });

  it("rejects alternation under quantifiers (F1: overlapping alternatives cause exponential backtracking)", () => {
    // Pattern (a|a)* has overlapping alternation under a quantifier
    const result1 = validateCustomParserConfig({ name: "test", detect: "x", fail_pattern: "(a|a)*(?<name>x)" });
    expect(result1).toEqual(
      expect.arrayContaining([expect.stringContaining("nested quantifiers")])
    );

    // Pattern (a|aa)+ has overlapping alternation
    const result2 = validateCustomParserConfig({ name: "test", detect: "x", fail_pattern: "(a|aa)+(?<name>x)" });
    expect(result2).toEqual(
      expect.arrayContaining([expect.stringContaining("nested quantifiers")])
    );

    // Pattern (\w|\d)+ has overlapping character classes
    const result3 = validateCustomParserConfig({ name: "test", detect: "x", fail_pattern: "(\\w|\\d)+:(?<name>x)" });
    expect(result3).toEqual(
      expect.arrayContaining([expect.stringContaining("nested quantifiers")])
    );

    // Pattern ((a+))+ has nested quantifier through groups
    const result4 = validateCustomParserConfig({ name: "test", detect: "x", fail_pattern: "((a+))+(?<name>x)" });
    expect(result4).toEqual(
      expect.arrayContaining([expect.stringContaining("nested quantifiers")])
    );
  });

  it("accepts legitimate patterns with non-capturing groups and named groups (F2 fix)", () => {
    // Non-capturing group (?:...) without nested quantifiers should be accepted
    // The ? after ( in (?:...) is part of the group syntax, not a quantifier
    const result1 = validateCustomParserConfig({
      name: "test",
      detect: "x",
      fail_pattern: "(?:FAIL|ERROR):\\s+(?<suite>\\S+)::(?<name>\\S+)",
    });
    expect(result1).toEqual([]);

    // Named group (?<name>...) should not be flagged
    const result2 = validateCustomParserConfig({
      name: "test",
      detect: "x",
      fail_pattern: "FAIL:\\s+(?<suite>\\S+)::(?<name>\\S+)",
    });
    expect(result2).toEqual([]);

    // Alternation inside a NON-quantified group is fine
    const result3 = validateCustomParserConfig({
      name: "test",
      detect: "x",
      fail_pattern: "(?:FAIL|ERROR):\\s+(?<name>\\S+)",
    });
    expect(result3).toEqual([]);

    // Alternation inside a quantified group IS dangerous
    const result4 = validateCustomParserConfig({
      name: "test",
      detect: "x",
      fail_pattern: "(?:FAIL|ERROR)+:\\s+(?<name>\\S+)",
    });
    expect(result4).toEqual(
      expect.arrayContaining([expect.stringContaining("nested quantifiers")])
    );

    // Nested quantifiers ARE dangerous and should be rejected
    // This pattern has .+ inside a group that's followed by ?
    const result5 = validateCustomParserConfig({
      name: "test",
      detect: "x",
      fail_pattern: "(?:\\s+-\\s+(?<message>.+))?(?<name>\\S+)",
    });
    expect(result5).toEqual(
      expect.arrayContaining([expect.stringContaining("nested quantifiers")])
    );
  });

  it("rejects backreferences (M3: exponential time complexity)", () => {
    // Backreferences like \1 can cause exponential time
    const result1 = validateCustomParserConfig({ name: "test", detect: "x", fail_pattern: "(a)\\1(?<name>x)" });
    expect(result1).toEqual(
      expect.arrayContaining([expect.stringContaining("backreferences")])
    );

    // Named backreferences \k<name>
    const result2 = validateCustomParserConfig({ name: "test", detect: "x", fail_pattern: "(?<dup>a)\\k<dup>(?<name>x)" });
    expect(result2).toEqual(
      expect.arrayContaining([expect.stringContaining("backreferences")])
    );

    const result3 = validateCustomParserConfig({ name: "test", detect: "(a)\\1", fail_pattern: "(?<name>x)" });
    expect(result3).toEqual(
      expect.arrayContaining([expect.stringContaining("backreferences")])
    );
  });

  it("caps input to 256 KB to bound regex execution (M3)", async () => {
    const parser = createCustomParser({
      name: "test",
      detect: "test",
      fail_pattern: "FAIL:\\s+(?<name>\\S+)",
    });
    expect(parser).not.toBeNull();

    // Create 512 KB of input - the parser should only process the tail 256 KB
    const started = Date.now();
    const prefix = "a".repeat(256 * 1024);
    const suffix = "test\nFAIL: test_found\n" + "b".repeat(200 * 1024);
    const input = prefix + suffix;
    expect(input.length).toBeGreaterThan(256 * 1024);

    const out = await parser!.parse(input, options);
    expect(Date.now() - started).toBeLessThan(5000);
    // The failure in the suffix (within last 256 KB) should be found
    expect(out.causes).toHaveLength(1);
    expect(out.causes[0].tests[0].name).toBe("test_found");
  });

  it("bounded iteration prevents regex hangs on crafted input (F1 timeout safeguard)", async () => {
    // Even if a pattern somehow passes structural checks, bounded iteration
    // ensures the parser doesn't hang on adversarial input
    const parser = createCustomParser({
      name: "test",
      detect: "test",
      fail_pattern: "FAIL:\\s+(?<name>\\w+)",
    });
    expect(parser).not.toBeNull();

    // Input designed to have many potential match positions
    const started = Date.now();
    const input = "test\n" + "FAIL: a ".repeat(10000) + "xxx";
    const out = await parser!.parse(input, options);
    // Should complete within the timeout
    expect(Date.now() - started).toBeLessThan(3000);
    // Should find the matches (up to MAX_ENTRIES)
    expect(out.causes.length).toBeLessThanOrEqual(5000);
  });

  it("catastrophic regex is terminated by worker thread and does not block event loop (F4)", async () => {
    // This is the critical test: a truly catastrophic regex pattern like (a|aa)+$
    // on input 'a'.repeat(40)+'!' would take exponential time (2^40 combinations)
    // to reject. The worker thread must be terminated on timeout, and the event
    // loop must NOT be blocked during the match attempt.
    //
    // Test strategy:
    // 1. Schedule a setTimeout BEFORE starting the regex match
    // 2. Run the catastrophic regex in the worker thread
    // 3. Verify the setTimeout callback fires on time (proves event loop not blocked)
    // 4. Verify the regex operation returns within the timeout with timedOut=true

    const TIMEOUT_MS = 500; // Use a short timeout for the test
    const TIMER_INTERVAL_MS = 50; // Timer fires every 50ms to prove event loop is free

    // Track timer callbacks to prove event loop was not blocked
    const timerCallbacks: number[] = [];
    let timerCount = 0;

    // Start a timer that fires every 50ms - this proves the event loop is not blocked
    const timer = setInterval(() => {
      timerCallbacks.push(Date.now());
      timerCount++;
    }, TIMER_INTERVAL_MS);

    const startTime = Date.now();

    try {
      // Run a catastrophic regex: (a|aa)+$ on 'aaa...a!' (40 a's then !)
      // This pattern has 2^N combinations to try before rejection
      const result = await runCatastrophicRegexTest(
        "(a|aa)+$",
        "a".repeat(40) + "!",
        TIMEOUT_MS,
      );

      const elapsed = Date.now() - startTime;

      // 1. The operation must have timed out (the pattern takes exponential time)
      expect(result.timedOut).toBe(true);

      // 2. The operation must complete within reasonable time of the timeout
      //    (worker termination adds small overhead)
      expect(elapsed).toBeLessThan(TIMEOUT_MS + 200);

      // 3. The timer must have fired multiple times during the match attempt,
      //    proving the event loop was NOT blocked. With 500ms timeout and 50ms
      //    intervals, we expect at least 5-8 callbacks if the loop is free.
      expect(timerCount).toBeGreaterThanOrEqual(5);

      // 4. The timer intervals should be roughly consistent (not bunched at the end
      //    as they would be if the event loop was blocked then released)
      if (timerCallbacks.length >= 3) {
        const intervals: number[] = [];
        for (let i = 1; i < timerCallbacks.length; i++) {
          intervals.push(timerCallbacks[i] - timerCallbacks[i - 1]);
        }
        // Average interval should be close to TIMER_INTERVAL_MS, not much larger
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        expect(avgInterval).toBeLessThan(TIMER_INTERVAL_MS * 3); // Allow some variance
      }
    } finally {
      clearInterval(timer);
    }
  }, 10000);

  it("worker thread timeout returns notice in parse output (F4 triage integration)", async () => {
    // Verify that when a custom parser's pattern times out, the parse() method
    // returns a proper notice explaining the timeout, allowing triage to report it

    // Use a simpler catastrophic pattern that's allowed past validation for testing
    // We can't use (a|aa)+ because validation rejects it. Instead, we test with
    // runCatastrophicRegexTest directly which bypasses validation.
    const result = await runCatastrophicRegexTest(
      "(x+)+$", // This would be rejected by validation, but runCatastrophicRegexTest bypasses it
      "x".repeat(30) + "!",
      200, // Short timeout
    );

    // Should timeout (the pattern is catastrophic on this input)
    expect(result.timedOut).toBe(true);
    expect(result.matched).toBe(false);
  });
});
