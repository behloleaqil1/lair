import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AnswerCredential, cookieValue, dashboardRequestProblem } from "./answer-auth.js";

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const SAME_ORIGIN = { origin: "http://127.0.0.1:4777", "sec-fetch-site": "same-origin" };

describe("AnswerCredential", () => {
  it("creates a random token with mode 0600 once, and loads the same one afterwards", () => {
    dir = mkdtempSync(join(tmpdir(), "lair-answer-token-"));
    const path = join(dir, "data", "decisions.answer-token");
    const created = AnswerCredential.loadOrCreate(path);
    expect(created.created).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const token = readFileSync(path, "utf-8").trim();
    expect(created.matchesToken(token)).toBe(true);

    const loaded = AnswerCredential.loadOrCreate(path);
    expect(loaded.created).toBe(false);
    expect(loaded.matchesToken(token)).toBe(true);
    expect(loaded.sessionCookie()).toBe(created.sessionCookie());
    expect(loaded.setupUrl("http://127.0.0.1:4777/")).toBe(`http://127.0.0.1:4777/#answer-token=${token}`);
  });

  it("replaces a token file that is too short to be one Lair wrote, and tightens its mode", () => {
    dir = mkdtempSync(join(tmpdir(), "lair-answer-token-"));
    const path = join(dir, "decisions.answer-token");
    writeFileSync(path, "weak\n", { mode: 0o644 });
    const credential = AnswerCredential.loadOrCreate(path);
    expect(credential.created).toBe(true);
    expect(credential.matchesToken("weak")).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("allows answering only with its session cookie on a same-origin dashboard request", () => {
    const credential = new AnswerCredential("t".repeat(43));
    const cookie = credential.sessionCookie().split(";")[0];
    expect(credential.answerProblem({ ...SAME_ORIGIN, cookie })).toBeNull();
    expect(credential.answerProblem({ ...SAME_ORIGIN, cookie: `other=1; ${cookie}` })).toBeNull();
    expect(credential.answerProblem({ cookie })).toBe("no Origin header");
    expect(credential.answerProblem(SAME_ORIGIN)).toBe("answering is not unlocked in this browser");
    expect(credential.answerProblem({ ...SAME_ORIGIN, cookie: "lair_decisions=forged" })).toBe(
      "answering is not unlocked in this browser",
    );
    const otherServer = new AnswerCredential("u".repeat(43)).sessionCookie().split(";")[0];
    expect(credential.answerProblem({ ...SAME_ORIGIN, cookie: otherServer })).toBe(
      "answering is not unlocked in this browser",
    );
    expect(credential.matchesToken("t".repeat(42))).toBe(false);
    expect(credential.matchesToken(undefined)).toBe(false);
  });
});

describe("dashboardRequestProblem", () => {
  it("needs a dashboard Origin and Sec-Fetch-Site: same-origin", () => {
    expect(dashboardRequestProblem(SAME_ORIGIN)).toBeNull();
    expect(dashboardRequestProblem({ origin: "http://localhost:5173", "sec-fetch-site": "same-origin" })).toBeNull();
    expect(dashboardRequestProblem({})).toBe("no Origin header");
    expect(dashboardRequestProblem({ origin: "null", "sec-fetch-site": "same-origin" })).toBe(
      "an invalid Origin header",
    );
    expect(dashboardRequestProblem({ origin: "http://attacker.example", "sec-fetch-site": "same-origin" })).toBe(
      "not the dashboard's origin",
    );
    expect(dashboardRequestProblem({ origin: "http://127.0.0.1:4777" })).toBe("not a same-origin browser request");
    expect(dashboardRequestProblem({ origin: "http://127.0.0.1:4777", "sec-fetch-site": "same-site" })).toBe(
      "not a same-origin browser request",
    );
  });

  it("reads one cookie from a Cookie header", () => {
    expect(cookieValue("a=1; lair_decisions=xyz; b=2", "lair_decisions")).toBe("xyz");
    expect(cookieValue("a=1", "lair_decisions")).toBeUndefined();
    expect(cookieValue(undefined, "lair_decisions")).toBeUndefined();
  });
});
