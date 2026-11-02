/**
 * Worker thread for regex matching with a hard timeout. The main thread can
 * terminate() this worker if the regex takes too long, providing a true
 * time bound that withTimeout() cannot achieve (withTimeout can only measure
 * time after the regex finishes).
 *
 * This module uses isMainThread to detect whether it's running as the worker
 * or being imported by the main thread. When run as a worker, it listens for
 * messages and executes regex operations.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";

export interface RegexRequest {
  kind: "test" | "matchAll";
  pattern: string;
  flags: string;
  text: string;
  maxMatches?: number;
}

export interface TestResult {
  kind: "test";
  matched: boolean;
}

export interface MatchAllResult {
  kind: "matchAll";
  matches: Array<{
    index: number;
    match: string;
    groups: Record<string, string | undefined>;
  }>;
}

export type RegexResult = TestResult | MatchAllResult;

// Worker execution: runs when this file is loaded as a worker thread
if (!isMainThread && parentPort) {
  const req = workerData as RegexRequest;

  try {
    const regex = new RegExp(req.pattern, req.flags);

    if (req.kind === "test") {
      const matched = regex.test(req.text);
      parentPort.postMessage({ kind: "test", matched } satisfies TestResult);
    } else {
      const matches: MatchAllResult["matches"] = [];
      const maxMatches = req.maxMatches ?? 5000;
      let match: RegExpExecArray | null;
      let iterations = 0;
      const maxIterations = maxMatches * 10;

      while ((match = regex.exec(req.text)) !== null) {
        iterations++;
        if (iterations > maxIterations) break;

        // Skip zero-length matches to prevent infinite loops
        if (match[0].length === 0) {
          regex.lastIndex++;
          continue;
        }

        matches.push({
          index: match.index,
          match: match[0],
          groups: match.groups ? { ...match.groups } : {},
        });

        if (matches.length >= maxMatches) break;
      }

      parentPort.postMessage({ kind: "matchAll", matches } satisfies MatchAllResult);
    }
  } catch (e) {
    // Report errors through the message channel
    parentPort.postMessage({ kind: req.kind, error: e instanceof Error ? e.message : String(e) });
  }
}
