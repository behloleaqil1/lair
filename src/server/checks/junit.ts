/**
 * JUnit XML parser: extract failing test names from JUnit XML output.
 *
 * Parses only bounded input to prevent DoS from malicious output.
 */

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

  // Match testcase elements with failure or error children
  // Pattern: <testcase ... name="..." ...> ... <failure|error ...> ... </testcase>
  // Use word boundary \b before 'name' to avoid matching 'classname'
  const testcaseRegex = /<testcase[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/testcase>/gi;

  let match: RegExpExecArray | null;
  while ((match = testcaseRegex.exec(bounded)) !== null && failures.length < MAX_FAILURES) {
    const [, name, content] = match;
    // Check if the testcase has a failure or error element
    if (/<(failure|error)/i.test(content)) {
      // Sanitize the name: no special chars that could escape
      const sanitized = name.replace(/[<>&"'`$(){}[\]\\;|]/g, "_").slice(0, 200);
      failures.push(sanitized);
    }
  }

  return failures;
}

/**
 * Check if content looks like JUnit XML.
 */
export function isJUnitXml(content: string): boolean {
  const sample = content.slice(0, 500);
  return /<testsuites?/i.test(sample) || /<testsuite/i.test(sample);
}
