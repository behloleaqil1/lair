/**
 * JUnit XML reports (JUnit, Surefire, Gradle, pytest --junitxml, vitest and
 * jest JUnit reporters). Each failed testcase becomes a raw failure with its
 * stack trace, so "Caused by" chains and field errors are kept; a context
 * failure is one cause however many testcases it failed.
 */
import type { TestRef } from "../../../shared/triage-types.js";
import { cut, groupFailures, makeTest, parseThrowable, pytestTest, type RawFailure } from "../text.js";
import { parseXml, type XmlElement } from "./xml.js";
import type { EvidenceParser, ParseOptions, ParseOutput } from "./types.js";

function testOf(testcase: XmlElement, suite: string): TestRef {
  const classname = cut(testcase.attrs.classname || suite, 500);
  const name = cut(testcase.attrs.name || "(unnamed)", 500);
  const file = testcase.attrs.file ? cut(testcase.attrs.file, 500) : undefined;
  if (file && file.endsWith(".py")) {
    // pytest: rebuild the node id from the file and the class part of the classname
    const module = file.replace(/\.py$/, "").split("/").filter(Boolean).join(".");
    const classes = classname.startsWith(`${module}.`) ? classname.slice(module.length + 1).split(".") : [];
    return pytestTest([file, ...classes, name].join("::"));
  }
  return makeTest(classname || file || "(unknown)", name, { file });
}

/** A report's failure body as bounded lines (the first ones: the error and its chain come first). */
function bodyLines(text: string): string[] {
  const lines = text.split("\n");
  return (lines.length > MAX_BODY_LINES ? lines.slice(0, MAX_BODY_LINES) : lines).map((l) => cut(l));
}

const MAX_BODY_LINES = 2000;

function firstLine(text: string): string {
  const lines = bodyLines(text);
  return lines.find((l) => l.trim().length > 0)?.trim() ?? "";
}

export function parseJUnit(xml: string, options: ParseOptions): ParseOutput {
  const root = parseXml(xml);
  const raws: RawFailure[] = [];
  const passed: TestRef[] = [];
  const flaky: TestRef[] = [];

  const visit = (testcase: XmlElement, suite: string) => {
    const test = testOf(testcase, suite);
    const failures = testcase.children.filter((c) => c.name === "failure" || c.name === "error");
    const reruns = testcase.children.filter((c) => c.name === "flakyFailure" || c.name === "flakyError");
    const skipped = testcase.children.some((c) => c.name === "skipped");
    if (failures.length === 0) {
      if (!skipped) passed.push(test);
      if (reruns.length > 0) flaky.push(test);
      return;
    }
    const failure = failures[0];
    const lines = bodyLines(failure.text);
    const head = parseThrowable(firstLine(failure.text));
    // Some reporters leave out `type` and write "AssertionError: ..." as the message
    const attrMessage = firstLine(failure.attrs.message ?? "");
    const fromAttr = attrMessage && !failure.attrs.type ? parseThrowable(attrMessage) : null;
    const message = (fromAttr?.type ? fromAttr.message : attrMessage) || head.message;
    raws.push({
      test,
      type: failure.attrs.type || fromAttr?.type || head.type,
      message,
      lines,
      parser: "junit",
      step: options.step,
    });
  };

  // Depth-first, in document order, without recursion
  const stack: { element: XmlElement; suite: string; testcase: boolean }[] = [
    { element: root, suite: "", testcase: false },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.testcase) {
      visit(frame.element, frame.suite);
      continue;
    }
    const children = frame.element.children;
    for (let k = children.length - 1; k >= 0; k--) {
      const child = children[k];
      const suite = child.name === "testsuite" ? child.attrs.name || frame.suite : frame.suite;
      stack.push({ element: child, suite, testcase: child.name === "testcase" });
    }
  }

  return {
    causes: groupFailures(raws, options.contextPatterns),
    passed,
    flaky,
    failedCount: raws.length,
  };
}

export const junitParser: EvidenceParser = {
  id: "junit",
  source: "report",
  detect: (text) => /<testsuites?[\s>]/.test(text.slice(0, 64 * 1024)),
  parse: parseJUnit,
};
