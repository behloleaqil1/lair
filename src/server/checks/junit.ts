/**
 * JUnit XML parser: extract failing test names from JUnit XML output.
 *
 * Uses the shared XML parser for proper handling of self-closing tags,
 * nested elements, and other XML edge cases. Parses only bounded input
 * to prevent DoS from malicious output.
 */

import { parseXml, type XmlElement } from "../triage/parsers/xml.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_FAILURES = 50;

/**
 * Parse JUnit XML and extract failing test names.
 * Returns at most MAX_FAILURES names.
 */
export function parseJUnitFailures(xml: string): string[] {
  // Bound input
  const bounded = xml.slice(0, MAX_INPUT_BYTES);
  const failures: string[] = [];

  const root = parseXml(bounded);

  // Walk the tree to find testcase elements with failure or error children
  const stack: XmlElement[] = [...root.children];
  while (stack.length > 0 && failures.length < MAX_FAILURES) {
    const element = stack.pop()!;

    if (element.name === "testcase") {
      // Check if this testcase has a failure or error child
      const hasFailed = element.children.some(
        (child) => child.name === "failure" || child.name === "error",
      );
      if (hasFailed && element.attrs.name) {
        // Sanitize the name: no special chars that could escape
        const sanitized = element.attrs.name.replace(/[<>&"'`$(){}[\]\\;|]/g, "_").slice(0, 200);
        failures.push(sanitized);
      }
    }

    // Add children to stack in reverse order to process in document order
    for (let i = element.children.length - 1; i >= 0; i--) {
      stack.push(element.children[i]);
    }
  }

  return failures;
}

/**
 * Check if content looks like JUnit XML.
 * Uses the same pattern as the triage module's junit parser.
 */
export function isJUnitXml(content: string): boolean {
  return /<testsuites?[\s>]/.test(content.slice(0, 64 * 1024));
}
