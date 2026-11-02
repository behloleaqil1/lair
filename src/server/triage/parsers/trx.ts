/**
 * .NET trx (Visual Studio Test Results) XML parser: MSTest, NUnit, xUnit
 * when run with `dotnet test --logger trx`. The format uses UnitTestResult
 * elements with outcome "Failed" or "Passed", linked to UnitTest definitions
 * by testId. Each failed result has an Output/ErrorInfo with Message and
 * StackTrace.
 */
import type { TestRef } from "../../../shared/triage-types.js";
import { cut, groupFailures, makeTest, parseThrowable, type RawFailure } from "../text.js";
import { parseXml, type XmlElement } from "./xml.js";
import type { EvidenceParser, ParseOptions, ParseOutput } from "./types.js";

const MAX_BODY_LINES = 2000;

function bodyLines(text: string): string[] {
  const lines = text.split("\n");
  return (lines.length > MAX_BODY_LINES ? lines.slice(0, MAX_BODY_LINES) : lines).map((l) => cut(l));
}

interface TestDefinition {
  name: string;
  className: string;
  /** The storage (DLL) name */
  storage?: string;
}

/** Find all elements with a given name in the tree (depth-first, no recursion). */
function findAll(root: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const stack: XmlElement[] = [...root.children].reverse();
  while (stack.length > 0) {
    const el = stack.pop()!;
    if (el.name === name) out.push(el);
    for (let k = el.children.length - 1; k >= 0; k--) stack.push(el.children[k]);
  }
  return out;
}

/** Find the first child element with a given name. */
function findChild(parent: XmlElement, name: string): XmlElement | undefined {
  return parent.children.find((c) => c.name === name);
}

/** Get text content from a child element. */
function childText(parent: XmlElement, name: string): string {
  return findChild(parent, name)?.text ?? "";
}

export function parseTrx(xml: string, options: ParseOptions): ParseOutput {
  const root = parseXml(xml);
  const raws: RawFailure[] = [];
  const passed: TestRef[] = [];
  const flaky: TestRef[] = [];

  // Build a map of testId -> test definition
  const definitions = new Map<string, TestDefinition>();
  const testDefinitions = findAll(root, "UnitTest");
  for (const def of testDefinitions) {
    const id = def.attrs.id;
    const name = def.attrs.name || "(unnamed)";
    const testMethod = findChild(def, "TestMethod");
    const className = testMethod?.attrs.className ?? "";
    const storage = def.attrs.storage;
    if (id) {
      definitions.set(id, { name: cut(name, 500), className: cut(className, 500), storage });
    }
  }

  // Process test results
  const results = findAll(root, "UnitTestResult");
  for (const result of results) {
    const testId = result.attrs.testId;
    const outcome = result.attrs.outcome;
    const testName = result.attrs.testName || "(unnamed)";

    // Get test definition for more context
    const def = testId ? definitions.get(testId) : undefined;
    const name = def?.name ?? cut(testName, 500);
    const suite = def?.className ?? "(unknown)";

    const test = makeTest(suite, name);

    if (outcome === "Passed") {
      passed.push(test);
      continue;
    }

    // Failed outcomes: Failed, Error, Timeout, Aborted
    // NotExecuted and Inconclusive are skipped (not run)
    if (outcome !== "Failed" && outcome !== "Error" && outcome !== "Timeout" && outcome !== "Aborted") {
      // Skip other outcomes (NotExecuted, Inconclusive, etc.)
      continue;
    }

    // Extract error info
    const output = findChild(result, "Output");
    const errorInfo = output ? findChild(output, "ErrorInfo") : undefined;
    const message = errorInfo ? childText(errorInfo, "Message") : "";
    const stackTrace = errorInfo ? childText(errorInfo, "StackTrace") : "";
    const stdOut = output ? childText(output, "StdOut") : "";

    const lines = bodyLines([message, stackTrace, stdOut].filter((s) => s).join("\n"));

    // Try to extract .NET exception type from the message
    // Format: "System.Data.SqlClient.SqlException : message" (space before colon)
    // Or: "Xunit.Sdk.EqualException : message"
    const dotnetExMatch = message.match(/^((?:[A-Za-z_][\w]*\.)+[A-Za-z_][\w]*(?:Exception|Error|Failure)?)\s*:\s*(.*)$/s);
    let errorType: string | undefined;
    let errorMessage: string;

    if (dotnetExMatch) {
      errorType = dotnetExMatch[1];
      errorMessage = dotnetExMatch[2].trim() || message.slice(0, 200);
    } else {
      const head = parseThrowable(message.split("\n")[0] ?? "");
      errorType = head.type;
      errorMessage = head.message || message.slice(0, 200);
    }

    raws.push({
      test,
      type: errorType,
      message: errorMessage,
      lines,
      parser: "trx",
      step: options.step,
    });
  }

  return {
    causes: groupFailures(raws, options.contextPatterns),
    passed,
    flaky,
    failedCount: raws.length > 0 ? raws.length : undefined,
  };
}

export const trxParser: EvidenceParser = {
  id: "trx",
  source: "report",
  detect: (text) => {
    // TRX files have a TestRun root element with xmlns containing the Microsoft TeamTest namespace.
    // The namespace URL is "http://microsoft.com/schemas/VisualStudio/TeamTest/2010" (or similar years).
    // Detection must work on the first 2000 characters of a real TRX file, where:
    // - <TestRun may have attributes before the xmlns
    // - The namespace contains "VisualStudio" and "TeamTest" (not "vstst" which doesn't appear)
    const head = text.slice(0, 2000);
    return /<TestRun[\s>]/.test(head) && /VisualStudio\/TeamTest/i.test(head);
  },
  parse: parseTrx,
};
