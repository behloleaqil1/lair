/**
 * The evidence parser interface. A parser turns one machine-readable report
 * or console log into causes, and lists the tests it saw pass.
 */
import type { FailureCause, TestRef } from "../../../shared/triage-types.js";

export interface ParseOptions {
  /** The gate step the text came from */
  step?: string;
  /** Failures matching one of these are context failures (one cause for all their tests) */
  contextPatterns: RegExp[];
}

export interface ParseOutput {
  causes: FailureCause[];
  /** Tests the report shows passing */
  passed: TestRef[];
  /** Tests that failed and then passed on a rerun inside the same run */
  flaky: TestRef[];
  /** Failed tests as the report counts them (its summary line), when it has one */
  failedCount?: number;
  /** Notes about parsing issues (e.g., pattern timed out) */
  notes?: string[];
}

export interface EvidenceParser {
  /** junit, gradle, vitest, jest, pytest, or a plugin's own id */
  id: string;
  /** Machine-readable reports first; console parsers are tried on step output */
  source: "report" | "console";
  /**
   * True when the text looks like this parser's format. `lines` is the text
   * as bounded lines (boundedLines()): console parsers read only those, so a
   * huge line never meets a regular expression.
   */
  detect(text: string, lines: string[]): boolean;
  /** Reads bounded input only (boundedLines(), or the XML reader's caps) */
  parse(text: string, options: ParseOptions): ParseOutput;
}

/**
 * Async evidence parser interface. Custom parsers use this to run regex in
 * worker threads with hard timeouts. Built-in parsers stay sync.
 */
export interface AsyncEvidenceParser {
  /** The parser id (e.g., a custom parser name) */
  id: string;
  /** Source type - custom parsers are console parsers */
  source: "report" | "console";
  /** Async detect: may run regex in a worker thread */
  detect(text: string, lines: string[]): Promise<boolean>;
  /** Async parse: may run regex in worker threads */
  parse(text: string, options: ParseOptions): Promise<ParseOutput>;
}

/** Check if a parser is async (has Promise-returning methods) */
export function isAsyncParser(parser: EvidenceParser | AsyncEvidenceParser): parser is AsyncEvidenceParser {
  // Custom parsers created with createCustomParser are marked async
  return (parser as { async?: boolean }).async === true;
}
