/**
 * PRs view - open pull requests
 */
import { useApi } from "../hooks/useApi";
import type { PullRequest } from "../../shared/types";

interface Props {
  project: string;
  refreshKey: number;
}

export function PRs({ project, refreshKey }: Props) {
  const {
    data: prs,
    loading,
    error,
  } = useApi<PullRequest[]>("/prs", project, refreshKey);

  if (loading) return <div className="loading">Loading PRs...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!prs) return null;

  const mergeReady = prs.filter((pr) => pr.mergeReady);
  const notReady = prs.filter((pr) => !pr.mergeReady);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <h2>Pull Requests ({prs.length})</h2>
        <span
          className="badge badge-neutral"
          style={{ fontSize: "0.7rem" }}
          title="Polling mode - data from GitHub"
        >
          📡 Polling
        </span>
      </div>

      {/* Merge ready */}
      <div className="card">
        <h3>
          ✅ Merge Ready{" "}
          <span
            style={{ color: "var(--text-secondary)", fontWeight: "normal" }}
          >
            ({mergeReady.length})
          </span>
        </h3>
        {mergeReady.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>
            No PRs ready to merge
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Title</th>
                <th>Branch</th>
                <th>Mergeable</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {mergeReady.map((pr) => (
                <tr key={pr.number}>
                  <td>
                    <span className="badge badge-success">#{pr.number}</span>
                  </td>
                  <td>{pr.title}</td>
                  <td style={{ fontSize: "0.85rem" }}>
                    <code>{pr.headRefName}</code>
                  </td>
                  <td>
                    <MergeableStatus status={pr.mergeable} />
                  </td>
                  <td
                    style={{
                      fontSize: "0.85rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {formatDate(pr.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Not ready */}
      <div className="card">
        <h3>
          Pending{" "}
          <span
            style={{ color: "var(--text-secondary)", fontWeight: "normal" }}
          >
            ({notReady.length})
          </span>
        </h3>
        {notReady.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>No pending PRs</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Title</th>
                <th>Branch</th>
                <th>Mergeable</th>
                <th>Gate Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {notReady.map((pr) => (
                <tr key={pr.number}>
                  <td>
                    <span className="badge badge-neutral">#{pr.number}</span>
                  </td>
                  <td
                    style={{
                      maxWidth: "300px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {pr.title}
                  </td>
                  <td style={{ fontSize: "0.85rem" }}>
                    <code>{pr.headRefName}</code>
                  </td>
                  <td>
                    <MergeableStatus status={pr.mergeable} />
                  </td>
                  <td>
                    {pr.latestGate ? (
                      <span className="badge badge-warning">Has gate</span>
                    ) : (
                      <span className="badge badge-neutral">No gate</span>
                    )}
                  </td>
                  <td
                    style={{
                      fontSize: "0.85rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {formatDate(pr.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function MergeableStatus({ status }: { status: string }) {
  switch (status) {
    case "MERGEABLE":
      return <span className="badge badge-success">Mergeable</span>;
    case "CONFLICTING":
      return <span className="badge badge-error">Conflicts</span>;
    default:
      return <span className="badge badge-neutral">{status}</span>;
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffHours = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60),
  );

  if (diffHours < 1) return "Just now";
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffHours < 48) return "Yesterday";
  return date.toLocaleDateString();
}
