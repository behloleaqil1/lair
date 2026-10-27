/**
 * API hook for fetching data with auto-refresh.
 *
 * Fetches `/api<endpoint>?project=` whenever the endpoint, the project or
 * the refresh key changes. A refresh keeps the data it has until the new
 * answer arrives; another endpoint or project starts empty, so a detail
 * never shows the previous row's data. `owner` sends this browser's owner
 * session (owner-session.ts) for the owner-only reads; `skip` fetches
 * nothing (a module that is off, a reader who is not signed in).
 */
import { useEffect, useRef, useState } from "react";
import { ownerHeaders } from "../owner-session";

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface ApiOptions {
  /** Send the owner session (owner-only routes) */
  owner?: boolean;
  /** Fetch nothing */
  skip?: boolean;
}

/** The request URL: the endpoint under /api, with ?project= (none for an empty name: the server's default). */
export function apiUrl(endpoint: string, project: string): string {
  if (!project) return `/api${endpoint}`;
  const sep = endpoint.includes("?") ? "&" : "?";
  return `/api${endpoint}${sep}project=${encodeURIComponent(project)}`;
}

export function useApi<T>(endpoint: string, project: string, refreshKey: number, options: ApiOptions = {}) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!options.skip);
  const [error, setError] = useState<string | null>(null);
  const source = `${endpoint}|${project}`;
  const lastSource = useRef(source);
  const owner = options.owner === true;
  const skip = options.skip === true;

  useEffect(() => {
    if (lastSource.current !== source) {
      lastSource.current = source;
      setData(null);
    }
    if (skip) {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    // An answer for another endpoint or project (the reader moved on) is dropped; a slow answer
    // for this one still lands after the next refresh started
    const stale = () => lastSource.current !== source;

    fetch(apiUrl(endpoint, project), owner ? { headers: ownerHeaders() } : undefined)
      .then((res) => res.json())
      .then((response: ApiResponse<T>) => {
        if (stale()) return;
        if (response.success && response.data !== undefined) {
          setData(response.data);
          setError(null);
        } else {
          setError(response.error || "Unknown error");
        }
      })
      .catch((err: unknown) => {
        if (!stale()) setError(err instanceof Error && err.message ? err.message : "Network error");
      })
      .finally(() => {
        if (!stale()) setLoading(false);
      });
  }, [endpoint, project, refreshKey, owner, skip, source]);

  return { data, loading, error };
}
