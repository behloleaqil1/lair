/**
 * JUnit XML reports (JUnit, Surefire, Gradle, pytest --junitxml, vitest and
 * jest JUnit reporters). Each failed testcase becomes a raw failure with its
 * stack trace, so "Caused by" chains and field errors are kept; a context
 * failure is one cause however many testcases it failed.
 */
import type { TestRef } from "../../../shared/triage-types.js";
import { groupFailures, makeTest, parseThrowable, pytestTest, type RawFailure } from "../text.js";
import { parseXml, type XmlElement } from "./xml.js";
import type { EvidenceParser, ParseOptions, ParseOutput } from "./types.js";

function testOf(testcase: XmlElement, suite: string): TestRef {
  const classname = testcase.attrs.classname || suite;
  const name = testcase.attrs.name || "(unnamed)";
  const file = testcase.attrs.file || undefined;
  if (file && file.endsWith(".py")) {
    // pytest: rebuild the node id from the file and the class part of the classname
    const module = file.replace(/\.py$/, "").split("/").filter(Boolean).join(".");
    const classes = classname.startsWith(`${module}.`) ? classname.slice(module.length + 1).split(".") : [];
    return pytestTest([file, ...classes, name].join("::"));
  }
  return makeTest(classname || file || "(unknown)", name, { file });
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
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
    const lines = failure.text.split("\n");
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

  const walk = (element: XmlElement, suite: string) => {
    for (const child of element.children) {
      if (child.name === "testsuite") walk(child, child.attrs.name || suite);
      else if (child.name === "testcase") visit(child, suite);
      else walk(child, suite);
    }
  };
  walk(root, "");

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
  detect: (text) => /<testsuites?[\s>]/.test(text),
  parse: parseJUnit,
};
