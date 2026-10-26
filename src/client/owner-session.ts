/**
 * This browser's owner session (src/server/human-auth/): signed in once
 * with the owner token, kept in this origin's localStorage (scheme, host
 * and port, so no other local server can read it), and sent in the
 * X-Lair-Owner-Session header on owner-only requests. Never a cookie.
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

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The session value this browser holds, or null. */
export function storedSession(): string | null {
  try {
    return storage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function keepSession(value: string | null): void {
  try {
    const s = storage();
    if (!s) return;
    if (value) s.setItem(STORAGE_KEY, value);
    else s.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private mode, policy): this browser just can't stay signed in
  }
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
