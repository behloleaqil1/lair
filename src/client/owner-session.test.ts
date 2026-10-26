import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNER_SESSION_HEADER, ownerHeaders, ownerStatus, signIn, storedSession, tokenFromHash } from "./owner-session";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, String(value)),
  };
}

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, data, error: status < 400 ? undefined : "refused" }), {
    status,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("owner session in the browser", () => {
  it("keeps the session from signing in in localStorage, and sends it only as a header", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const requests: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return reply({ session: "s".repeat(43), info: { id: "x", createdAt: "", lastUsedAt: "", userAgent: "" } }, 201);
    });
    expect(ownerHeaders()).toEqual({});
    await signIn("  the-owner-token  ");
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ token: "the-owner-token" });
    expect(requests[0].init?.credentials).toBeUndefined();
    expect(storedSession()).toBe("s".repeat(43));
    expect(ownerHeaders()).toEqual({ [OWNER_SESSION_HEADER]: "s".repeat(43) });
  });

  it("forgets a session the server no longer knows (signed out elsewhere, or a new owner token)", async () => {
    const storage = memoryStorage();
    storage.setItem("lair.ownerSession", "old-session-value-old-session-value-123");
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", async () => reply({ signedIn: false, session: null }));
    expect(await ownerStatus()).toEqual({ signedIn: false, session: null });
    expect(storedSession()).toBeNull();
  });

  it("works without storage (blocked or private mode): just not signed in", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(storedSession()).toBeNull();
    expect(ownerHeaders()).toEqual({});
    expect(await ownerStatus()).toEqual({ signedIn: false, session: null });
  });

  it("takes the owner token only from a setup link's fragment", () => {
    const token = "Abc_def-0123456789Abc_def-0123456789Abc_def";
    expect(tokenFromHash(`#owner-token=${token}`)).toBe(token);
    expect(tokenFromHash("")).toBeNull();
    expect(tokenFromHash("#owner-token=short")).toBeNull();
    expect(tokenFromHash(`#owner-token=${token}&next=/x`)).toBeNull();
  });
});
