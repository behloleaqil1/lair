import { describe, expect, it } from "vitest";
import { GitHubHost, type FetchLike, type FetchResponseLike } from "./github.js";

const answer = (status: number, headers: Record<string, string> = {}, body = "{}"): FetchResponseLike => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => body,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

function host(fetch: FetchLike, clock: { t: number }, timeoutMs?: number) {
  return new GitHubHost({ repo: "example/demo", apiUrl: "https://api.example.test", token: async () => "t", fetch, now: () => clock.t, timeoutMs });
}

describe("GitHubHost limits", () => {
  it("every request carries an abort signal, so a hung host ends instead of stalling the caller", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const h = host(async (_url, init) => (signals.push(init?.signal), answer(200, {}, JSON.stringify({ default_branch: "main" }))), { t: 0 }, 5);
    await h.getRepo();
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("a rate-limit answer (429 with Retry-After) stops further requests until the time is up", async () => {
    const clock = { t: 1_000_000 };
    let calls = 0;
    const h = host(async () => (calls++, answer(429, { "retry-after": "120" })), clock);
    await expect(h.getRepo()).rejects.toThrow();
    expect(calls).toBe(1);
    // Inside the wait: refused locally, the host is not asked
    clock.t += 60_000;
    await expect(h.getRepo()).rejects.toThrow(/rate limited/);
    expect(calls).toBe(1);
    // After it: asked again
    clock.t += 61_000;
    await expect(h.getRepo()).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("a 403 with no quota left backs off to the reset time", async () => {
    const clock = { t: 1_000_000 };
    let calls = 0;
    const reset = String(Math.ceil((clock.t + 300_000) / 1000));
    const h = host(async () => (calls++, answer(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset })), clock);
    await expect(h.getRepo()).rejects.toThrow();
    clock.t += 200_000;
    await expect(h.getRepo()).rejects.toThrow(/rate limited/);
    expect(calls).toBe(1);
  });
});
