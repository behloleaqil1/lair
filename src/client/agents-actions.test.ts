/**
 * The Agents view's stopping actions ask first, and send confirm: true only
 * once confirmed.
 */
import { describe, expect, it } from "vitest";
import { freshSessionAction, releaseClaimAction, runConfirmed } from "./agents-actions";

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
});
