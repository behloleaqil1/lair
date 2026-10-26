/**
 * This browser's owner session (src/server/human-auth/): signed in once
 * with the owner token and sent in the X-Lair-Owner-Session header on
 * owner-only requests. Never a cookie.
 *
 * Where it is kept depends on how the dashboard is served (keeperFor):
 * - the built dashboard (`npm start`, port 4777): this origin's
 *   localStorage, so it survives reloads. The origin is scheme, host and
 *   port, so no other local server can read it.
 * - the Vite dev server (`npm run dev`, port 5173): this page's memory
 *   only. Vite serves every file of the checkout from that origin, so an
 *   HTML file an agent commits would be same-origin and could read
 *   localStorage. Sign in again after a reload.
 */
export const OWNER_SESSION_HEADER = "X-Lair-Owner-Session";
const STORAGE_KEY = "lair.ownerSession";

export interface OwnerSessionInfo {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  userAgent: string;
  /** In the list: this browser's session */
  current?: boolean;
}

/** Where this page keeps its session value. */
export interface SessionKeeper {
  read(): string | null;
  write(value: string | null): void;
  /** True when a reload keeps the session */
  persistent: boolean;
}

/** This origin's localStorage. Blocked storage (private mode, policy) just means not signed in. */
export function localStorageKeeper(): SessionKeeper {
  const storage = (): Storage | null => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  };
  return {
    persistent: true,
    read() {
      try {
        return storage()?.getItem(STORAGE_KEY) ?? null;
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        const s = storage();
        if (!s) return;
        if (value) s.setItem(STORAGE_KEY, value);
        else s.removeItem(STORAGE_KEY);
      } catch {
        // Storage blocked: this browser just can't stay signed in
      }
    },
  };
}

/** This page's memory: nothing another page of the origin can read, gone on reload. */
export function memoryKeeper(): SessionKeeper {
  let value: string | null = null;
  return {
    persistent: false,
    read: () => value,
    write: (next) => {
      value = next;
    },
  };
}

/** The keeper for a dashboard served by the Vite dev server (`dev`), or built. */
export function keeperFor(dev: boolean): SessionKeeper {
  return dev ? memoryKeeper() : localStorageKeeper();
}

const keeper = keeperFor(import.meta.env.DEV === true);

/** False under `npm run dev`: a reload signs this browser out. */
export const sessionSurvivesReload = keeper.persistent;

/** The session value this browser holds, or null. */
export function storedSession(): string | null {
  return keeper.read();
}

function keepSession(value: string | null): void {
  keeper.write(value);
}

/** The header that makes a request the owner's, when this browser is signed in. */
export function ownerHeaders(): Record<string, string> {
  const value = storedSession();
  return value ? { [OWNER_SESSION_HEADER]: value } : {};
}

/** fetch an API route and unwrap `{success, data, error}`. */
export async function fetchApi<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json()) as { success: boolean; data?: T; error?: string };
  if (!body.success || body.data === undefined) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body.data;
}

/** Sign this browser in with the owner token (from data/owner.token or the setup link). */
export async function signIn(token: string): Promise<OwnerSessionInfo> {
  const data = await fetchApi<{ session: string; info: OwnerSessionInfo }>("/api/owner/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: token.trim() }),
  });
  keepSession(data.session);
  return data.info;
}

/** Is this browser signed in? A session the server no longer knows (signed out, new token) is dropped. */
export async function ownerStatus(): Promise<{ signedIn: boolean; session: OwnerSessionInfo | null }> {
  if (!storedSession()) return { signedIn: false, session: null };
  const status = await fetchApi<{ signedIn: boolean; session: OwnerSessionInfo | null }>("/api/owner/session", {
    headers: ownerHeaders(),
  });
  if (!status.signedIn) keepSession(null);
  return status;
}

/** The browsers signed in as the owner (needs this browser to be one of them). */
export function listOwnerSessions(): Promise<OwnerSessionInfo[]> {
  return fetchApi<OwnerSessionInfo[]>("/api/owner/sessions", { headers: ownerHeaders() });
}

/** Sign a browser out; signing this one out also forgets its session here. */
export async function revokeOwnerSession(id: string): Promise<void> {
  const result = await fetchApi<{ revoked: string; current: boolean }>(
    `/api/owner/sessions/${encodeURIComponent(id)}/revoke`,
    { method: "POST", headers: ownerHeaders() },
  );
  if (result.current) keepSession(null);
}

/** The token in a setup link's fragment (`#owner-token=...`), or null. */
export function tokenFromHash(hash: string): string | null {
  const match = /^#owner-token=([A-Za-z0-9_-]{32,200})$/.exec(hash);
  return match ? match[1] : null;
}
