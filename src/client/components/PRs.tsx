/**
 * PRs view - open pull requests and their merge readiness.
 *
 * With the review module on (review.enabled), readiness is the review
 * module's own evaluation of each PR at its head (pr-readiness.ts): "Merge
 * ready" only when it allows the merge, otherwise "Waiting: <first reason>".
 * Without it, nothing checks reviews, so the first group only says the gate
 * passed. An evaluation calls the git host several times, so a PR is
 * re-evaluated when its head changes, after READINESS_MAX_AGE_MS, or on
 * "Re-check readiness", not on the dashboard's timer.
 */
import { useEffect, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { prStatus } from "../review-api";
import {
  READINESS_MAX_AGE_MS,
  prsToCheck,
  readinessOf,
  readyGroupTitle,
  type ReadinessCheck,
  type Readiness,
} from "../pr-readiness";
import { TIER_BADGE } from "../review-view";
import type { PullRequest } from "../../shared/types";
import type { ReviewProjectInfo } from "../../shared/review-types";

interface Props {
  project: string;
  refreshKey: number;
}

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };

export function PRs({ project, refreshKey }: Props) {
  const { data: prs, loading, error } = useApi<PullRequest[]>("/prs", project, refreshKey);
  const info = useApi<ReviewProjectInfo>("/review/status", project, refreshKey);
  const reviewEnabled = info.data?.enabled === true;

  const [checks, setChecks] = useState<Record<number, ReadinessCheck>>({});
  const checksRef = useRef<Record<number, ReadinessCheck>>({});
  const inFlight = useRef(new Set<number>());
  const projectRef = useRef(project);
  const forceRef = useRef(false);
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    projectRef.current = project;
    checksRef.current = {};
    inFlight.current = new Set();
    setChecks({});
  }, [project]);

  // Ask the review module about the PRs that need it, one at a time
  useEffect(() => {
    if (!reviewEnabled || !prs) return;
    const force = forceRef.current;
    forceRef.current = false;
    const due = prsToCheck(prs, checksRef.current, Date.now(), { force, inFlight: inFlight.current });
    if (due.length === 0) return;
    const asked = project;
    const pending = inFlight.current;
    for (const pr of due) pending.add(pr.number);
    void (async () => {
      for (const pr of due) {
        let check: ReadinessCheck;
        try {
          const status = await prStatus(asked, pr.number);
          check = { headSha: pr.headRefOid, checkedAt: Date.now(), status, error: null };
        } catch (e) {
          check = {
            headSha: pr.headRefOid,
            checkedAt: Date.now(),
            status: null,
            error: e instanceof Error ? e.message : "the review module did not answer",
          };
        } finally {
          pending.delete(pr.number);
        }
        // The project changed while this was asked: the answer belongs to the old one
        if (projectRef.current !== asked) return;
        checksRef.current = { ...checksRef.current, [pr.number]: check };
        setChecks(checksRef.current);
      }
    })();
  }, [prs, reviewEnabled, project, recheck]);

  if (loading && !prs) return <div className="loading">Loading PRs...</div>;
  if (error && !prs) return <div className="error">Error: {error}</div>;
  if (!prs) return null;
  if (info.loading && !info.data && !info.error) return <div className="loading">Loading PRs...</div>;

  const rows = prs.map((pr) => ({ pr, readiness: readinessOf(pr, reviewEnabled, checks[pr.number]) }));
  const ready = rows.filter((r) => r.readiness.group === "ready");
  const waiting = rows.filter((r) => r.readiness.group === "waiting");
  const readyTitle = readyGroupTitle(reviewEnabled);

  const recheckAll = () => {
    forceRef.current = true;
    setRecheck((n) => n + 1);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
        <h2>Pull Requests ({prs.length})</h2>
        <span className="badge badge-neutral" style={{ fontSize: "0.7rem" }} title="Polling mode - data from GitHub">
          📡 Polling
        </span>
        {reviewEnabled && (
          <button
            onClick={recheckAll}
            style={{
              padding: "0.3rem 0.7rem",
              borderRadius: "4px",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            Re-check readiness
          </button>
        )}
      </div>

      {reviewEnabled ? (
        <p style={{ ...muted, marginBottom: "1rem" }}>
          Readiness comes from the review module (tier, required and present reviews, open blocking findings, the gate
          at the head, holds). A PR is checked again when its head changes or after {READINESS_MAX_AGE_MS / 60_000}{" "}
          minutes.
        </p>
      ) : (
        <p style={{ ...muted, marginBottom: "1rem" }}>
          Reviews are not checked: review.enabled is off for this project, so &quot;{readyTitle}&quot; only means a gate
          passed at the head.
          {info.error && ` (The review module's status could not be read: ${info.error})`}
        </p>
      )}

      <div className="card">
        <h3>
          {reviewEnabled ? "✅ " : ""}
          {readyTitle} <span style={{ color: "var(--text-secondary)", fontWeight: "normal" }}>({ready.length})</span>
        </h3>
        {ready.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>
            {reviewEnabled ? "No PRs ready to merge" : "No PRs with a passed gate"}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Title</th>
                <th>Branch</th>
                <th>Mergeable</th>
                {reviewEnabled && <th>Readiness</th>}
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {ready.map(({ pr, readiness }) => (
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
                  {reviewEnabled && (
                    <td>
                      <ReadinessCell readiness={readiness} />
                    </td>
                  )}
                  <td style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>{formatDate(pr.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>
          Pending <span style={{ color: "var(--text-secondary)", fontWeight: "normal" }}>({waiting.length})</span>
        </h3>
        {waiting.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>No pending PRs</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Title</th>
                <th>Branch</th>
                <th>Mergeable</th>
                <th>{reviewEnabled ? "Readiness" : "Gate Status"}</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map(({ pr, readiness }) => (
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
                    {reviewEnabled ? (
                      <ReadinessCell readiness={readiness} />
                    ) : pr.latestGate ? (
                      <span className="badge badge-warning">Has gate</span>
                    ) : (
                      <span className="badge badge-neutral">No gate</span>
                    )}
                  </td>
                  <td style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>{formatDate(pr.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ReadinessCell({ readiness }: { readiness: Readiness }) {
  return (
    <div>
      {readiness.tier && <span className={`badge ${TIER_BADGE[readiness.tier]}`}>{readiness.tier}</span>}{" "}
      <span style={readiness.group === "ready" ? undefined : muted}>{readiness.label}</span>
      {readiness.checkedAt !== null && (
        <div style={muted}>checked {new Date(readiness.checkedAt).toLocaleTimeString()}</div>
      )}
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
  const diffHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60));

  if (diffHours < 1) return "Just now";
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffHours < 48) return "Yesterday";
  return date.toLocaleDateString();
}
