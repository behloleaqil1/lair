/**
 * The Agents view's actions ask first: the stopping ones send confirm: true
 * only once confirmed, and the start-run form sends the run it describes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  failureMessage,
  freshSessionAction,
  modelsOf,
  ownerRequest,
  postJson,
  promptFileUrl,
  promptsUrl,
  releaseClaimAction,
  releaseFillHoldAction,
  runConfirmed,
  startRunAction,
} from "./agents-actions";
import { OWNER_SESSION_HEADER } from "./owner-session";
import type { AgentView } from "../shared/agents-types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function recorder(response: { success: boolean; error?: string } = { success: true }) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const post = async (url: string, body: Record<string, unknown>) => {
    posts.push({ url, body });
    return response;
  };
  return { posts, post };
}

describe("agents view actions", () => {
  it("send nothing when the question is declined", async () => {
    const { posts, post } = recorder();
    const asked: string[] = [];
    const result = await runConfirmed(
      releaseClaimAction("demo", "feat-login", "worker-a"),
      (question) => {
        asked.push(question);
        return false;
      },
      post,
    );
    expect(result).toEqual({ sent: false, ok: false });
    expect(posts).toEqual([]);
    expect(asked[0]).toContain("Release the claim on feat-login?");
  });

  it("release a claim with confirm: true once confirmed", async () => {
    const { posts, post } = recorder();
    const result = await runConfirmed(releaseClaimAction("my project", "feat-login", "worker-a"), () => true, post);
    expect(result).toEqual({ sent: true, ok: true });
    expect(posts).toEqual([
      { url: "/api/agents/claims/release?project=my%20project", body: { task: "feat-login", confirm: true } },
    ]);
  });

  it("release a fill hold with confirm: true only once confirmed", async () => {
    const action = releaseFillHoldAction("my project", "feat-login", "worker-a");
    expect(action.question).toContain("Let fill start feat-login again?");
    const { posts, post } = recorder();
    expect(await runConfirmed(action, () => false, post)).toEqual({ sent: false, ok: false });
    expect(posts).toEqual([]);
    expect(await runConfirmed(action, () => true, post)).toEqual({ sent: true, ok: true });
    expect(posts).toEqual([
      { url: "/api/agents/fill/release?project=my%20project", body: { task: "feat-login", confirm: true } },
    ]);
  });

  it("start a fresh session with confirm: true, and report the server's error", async () => {
    const { posts, post } = recorder({ success: false, error: "Run 1a2b3c4d is already stopping" });
    const action = freshSessionAction("demo", "1a2b3c4d-0000-4000-8000-000000000000", "worker-a", "feat-login");
    expect(action.question).toContain("moved aside (not deleted)");
    const result = await runConfirmed(action, () => true, post);
    expect(result).toEqual({ sent: true, ok: false, error: "Run 1a2b3c4d is already stopping" });
    expect(posts).toEqual([
      {
        url: "/api/agents/runs/1a2b3c4d-0000-4000-8000-000000000000/fresh-session?project=demo",
        body: { confirm: true },
      },
    ]);
  });

  it("send the owner session header with the JSON body; without a signed-in browser there is none", () => {
    expect(ownerRequest({ confirm: true }, { [OWNER_SESSION_HEADER]: "a-session-value" })).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json", [OWNER_SESSION_HEADER]: "a-session-value" },
      body: '{"confirm":true}',
    });
    // No localStorage here: not signed in, so the server will answer 403
    expect(ownerRequest({ confirm: true }).headers).toEqual({ "Content-Type": "application/json" });
  });
});

describe("the start-run form", () => {
  const agent = (models: (string | undefined)[]): AgentView =>
    ({
      id: "worker-a",
      profiles: models.map((model, i) => ({ adapter: i === 0 ? "test-cli" : "other-cli", model, provider: "p" })),
    }) as unknown as AgentView;

  it("sends the agent, the task, the prompt and the chosen model; no model for the agent's default", () => {
    const chosen = startRunAction("my project", {
      agent: "worker-a",
      task: "  feat-login  ",
      prompt: "Build the login form",
      model: "model-b",
    });
    expect(chosen.url).toBe("/api/agents/runs?project=my%20project");
    expect(chosen.body).toEqual({ agent: "worker-a", task: "feat-login", prompt: "Build the login form", model: "model-b" });
    expect(chosen.question).toBe(
      "Start worker-a on feat-login with model model-b? The task is claimed now, and the run starts on the next check.",
    );

    const byDefault = startRunAction("demo", { agent: "worker-a", task: "feat-login", prompt: "Build it", model: "" });
    expect(byDefault.body).toEqual({ agent: "worker-a", task: "feat-login", prompt: "Build it" });
    expect(byDefault.question).toContain("with its default model?");
  });

  it("offers only the agent's own models, each once, in profile order", () => {
    expect(modelsOf(agent(["model-a", undefined, "model-b", "model-a"]))).toEqual(["model-a", "model-b"]);
    expect(modelsOf(agent([undefined]))).toEqual([]);
  });

  it("sends nothing when declined; once confirmed, POSTs the JSON body and reports the status of a refusal", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ success: false, error: "Agent worker-a is busy: run 1a2b3c4d on task t is running" }), {
        status: 409,
      });
    });
    const action = startRunAction("demo", { agent: "worker-a", task: "feat-login", prompt: "Build it", model: "model-b" });

    expect(await runConfirmed(action, () => false, postJson)).toEqual({ sent: false, ok: false });
    expect(requests).toEqual([]);

    const result = await runConfirmed(action, () => true, postJson);
    expect(result).toEqual({
      sent: true,
      ok: false,
      error: "Agent worker-a is busy: run 1a2b3c4d on task t is running",
      status: 409,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/agents/runs?project=demo");
    expect(requests[0].init?.method).toBe("POST");
    expect(requests[0].init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      agent: "worker-a",
      task: "feat-login",
      prompt: "Build it",
      model: "model-b",
    });
    expect(failureMessage(result)).toBe("Conflict (409): Agent worker-a is busy: run 1a2b3c4d on task t is running");
  });

  it("explains a refusal by its status: 400, 403 (with the sign-in hint when it is the owner check), 404, 409", () => {
    const failed = (status: number | undefined, error: string) => failureMessage({ sent: true, ok: false, error, status });
    expect(failed(400, "Invalid task")).toBe("Invalid request (400): Invalid task");
    expect(failed(403, "Only the owner can do this, from the dashboard: this browser is not signed in as the owner")).toBe(
      "Refused (403): Only the owner can do this, from the dashboard: this browser is not signed in as the owner. Sign this browser in as the owner from the Decisions view.",
    );
    expect(failed(403, "Over budget: daily cost")).toBe("Refused (403): Over budget: daily cost");
    expect(failed(404, "The agents module is off for demo")).toBe("Not found (404): The agents module is off for demo");
    expect(failed(409, "Task t is already claimed")).toBe("Conflict (409): Task t is already claimed");
    expect(failed(undefined, "Network error")).toBe("Failed: Network error");
  });

  it("asks for prompt files by basename, as a query value", () => {
    expect(promptsUrl("my project")).toBe("/api/agents/prompts?project=my%20project");
    expect(promptFileUrl("demo", "feat login/x.txt")).toBe("/api/agents/prompts/file?project=demo&name=feat%20login%2Fx.txt");
  });
});
