import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_SESSION_HEADER,
  keeperFor,
  localStorageKeeper,
  memoryKeeper,
  ownerHeaders,
  ownerStatus,
  sessionSurvivesReload,
  signIn,
  storedSession,
  tokenFromHash,
} from "./owner-session";

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

const SESSION = "s".repeat(43);
const signedIn = () =>
  reply({ session: SESSION, info: { id: "x", createdAt: "", lastUsedAt: "", userAgent: "" } }, 201);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("owner session in the browser", () => {
  it("keeps the session from signing in, and sends it only as a header", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const requests: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return signedIn();
    });
    await signIn("  the-owner-token  ");
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ token: "the-owner-token" });
    expect(requests[0].init?.credentials).toBeUndefined();
    expect(storedSession()).toBe(SESSION);
    expect(ownerHeaders()).toEqual({ [OWNER_SESSION_HEADER]: SESSION });
  });

  it("forgets a session the server no longer knows (signed out elsewhere, or a new owner token)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("fetch", async () => signedIn());
    await signIn("the-owner-token");
    vi.stubGlobal("fetch", async () => reply({ signedIn: false, session: null }));
    expect(await ownerStatus()).toEqual({ signedIn: false, session: null });
    expect(storedSession()).toBeNull();
    expect(ownerHeaders()).toEqual({});
  });

  it("takes the owner token only from a setup link's fragment", () => {
    const token = "Abc_def-0123456789Abc_def-0123456789Abc_def";
    expect(tokenFromHash(`#owner-token=${token}`)).toBe(token);
    expect(tokenFromHash("")).toBeNull();
    expect(tokenFromHash("#owner-token=short")).toBeNull();
    expect(tokenFromHash(`#owner-token=${token}&next=/x`)).toBeNull();
  });
});

describe("where the session is kept", () => {
  it("under the Vite dev server, in this page's memory only: localStorage of that origin is readable by any file of the checkout", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const dev = keeperFor(true);
    expect(dev.persistent).toBe(false);
    dev.write(SESSION);
    expect(dev.read()).toBe(SESSION);
    expect(storage.length).toBe(0);
    // Another page (or a reload) starts with nothing
    expect(memoryKeeper().read()).toBeNull();
    // Vitest runs with import.meta.env.DEV, so this module keeps its session in memory
    expect(sessionSurvivesReload).toBe(import.meta.env.DEV !== true);
  });

  it("in the built dashboard, in this origin's localStorage, so it survives a reload", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const built = keeperFor(false);
    expect(built.persistent).toBe(true);
    built.write(SESSION);
    expect(storage.getItem("lair.ownerSession")).toBe(SESSION);
    expect(localStorageKeeper().read()).toBe(SESSION);
    built.write(null);
    expect(storage.length).toBe(0);
  });

  it("with blocked storage (private mode, a policy), just isn't signed in", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const keeper = localStorageKeeper();
    keeper.write(SESSION);
    expect(keeper.read()).toBeNull();
  });
});
