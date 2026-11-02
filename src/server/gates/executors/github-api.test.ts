/**
 * The GitHub REST client bounds every request: each one carries an abort
 * signal, and a request (or its body) with no answer in time fails with a
 * GitHubApiError, never an empty or "ok" answer. Only the fetch boundary is
 * faked.
 */
import { describe, expect, it } from "vitest";
import { GitHubApi, GitHubApiError } from "./github-api.js";
import type { HttpFetch, HttpResponse } from "./types.js";

const REPO = { private: false, visibility: "public", default_branch: "main" };

function response(text: () => Promise<string>, status = 200): HttpResponse {
  return { status, headers: { get: () => null }, text };
}

/** Rejects like fetch does once the signal fires */
function whenAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function api(fetch: HttpFetch, timeoutMs?: number): GitHubApi {
  return new GitHubApi({ repo: "example-org/example-app", token: "t", fetch, timeoutMs });
}

describe("GitHubApi request timeout", () => {
  it("sends an abort signal with every request", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const fetch: HttpFetch = async (_url, init) => {
      seen.push(init.signal);
      return response(async () => JSON.stringify(REPO));
    };
    await expect(api(fetch).getRepo()).resolves.toMatchObject({ defaultBranch: "main" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.aborted).toBe(false);
  });

  it("fails a request that gets no answer in time", async () => {
    const fetch: HttpFetch = (_url, init) => whenAborted(init.signal);
    const result = api(fetch, 20).getRepo();
    await expect(result).rejects.toBeInstanceOf(GitHubApiError);
    await expect(result).rejects.toThrow(/GET \/repos\/example-org\/example-app: no answer within/);
  });

  it("fails a request whose body stops arriving, instead of returning an empty answer", async () => {
    const fetch: HttpFetch = async (_url, init) => response(() => whenAborted(init.signal));
    await expect(api(fetch, 20).jobLog(7)).rejects.toThrow(/no answer within/);
  });

  it("keeps an unreachable host a failure", async () => {
    const fetch: HttpFetch = async () => {
      throw new Error("connect refused");
    };
    await expect(api(fetch).getRepo()).rejects.toThrow(/GitHub API unreachable: connect refused/);
  });
});
