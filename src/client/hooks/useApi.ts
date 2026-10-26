/**
 * API hook for fetching data with auto-refresh
 */
import { useState, useEffect } from "react";

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export function useApi<T>(
  endpoint: string,
  project: string,
  refreshKey: number,
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = project
      ? `/api${endpoint}?project=${encodeURIComponent(project)}`
      : `/api${endpoint}`;

    setLoading(true);
    setError(null);

    fetch(url)
      .then((res) => res.json())
      .then((response: ApiResponse<T>) => {
        if (response.success && response.data !== undefined) {
          setData(response.data);
          setError(null);
        } else {
          setError(response.error || "Unknown error");
        }
      })
      .catch((err) => {
        setError(err.message || "Network error");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [endpoint, project, refreshKey]);

  return { data, loading, error };
}
