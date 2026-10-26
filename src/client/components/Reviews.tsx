/**
 * Reviews view - per PR: the risk tier and the rules behind it, required vs
 * present reviews at the head, findings, the gate at the head, holds, and the
 * merge button with the reasons it is disabled. Merging asks for confirmation.
 *
 * Evaluating a PR calls the git host several times, so a PR's evaluation
 * refreshes on demand (Refresh, or after an action), not on the dashboard's
 * timer.
 * Configured in the project YAML (review:, see docs/configuration.md).
 */
import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import type {
  MergeHold,
  PrReviewStatus,
  PrSummary,
  ReviewFinding,
  ReviewProjectInfo,
} from "../../shared/review-types";
import { mergePr, prStatus, releaseHold, requestReviews, resolveFinding, submitOwnerReview } from "../review-api";
import {
  GATE_BADGE,
  TIER_BADGE,
  findingLocation,
  mergeButtonState,
  parseFindingLines,
  shortSha,
} from "../review-view";

interface Props {
  project: string;
  refreshKey: number;
}

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };

function buttonStyle(kind: "primary" | "danger" | "plain", disabled = false) {
  return {
    padding: "0.4rem 0.9rem",
    borderRadius: "4px",
    border: kind === "plain" ? "1px solid var(--border)" : "none",
    background: kind === "primary" ? "var(--accent, #3b82f6)" : kind === "danger" ? "var(--error)" : "transparent",
    color: kind === "plain" ? "var(--text)" : "white",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

function Flag({ ok }: { ok: boolean }) {
  return <span className={`badge ${ok ? "badge-success" : "badge-error"}`}>{ok ? "✓" : "✗"}</span>;
}

export function Reviews({ project, refreshKey }: Props) {
  const [localKey, setLocalKey] = useState(0);
  // The PR list is one host call, so it follows the dashboard's timer; a PR's evaluation does not
  const listKey = refreshKey + localKey;
  const info = useApi<ReviewProjectInfo>("/review/status", project, listKey);
  const prs = useApi<PrSummary[]>("/review/prs", project, listKey);
  const [selected, setSelected] = useState<number | null>(null);
  const [status, setStatus] = useState<PrReviewStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reviewer, setReviewer] = useState("owner");
  const [verdict, setVerdict] = useState<"approve" | "request_changes">("approve");
  const [summary, setSummary] = useState("");
  const [findingText, setFindingText] = useState("");

  useEffect(() => {
    setSelected(null);
    setStatus(null);
  }, [project]);

  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    setLoading(true);
    setStatusError(null);
    prStatus(project, selected)
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch((e) => !cancelled && setStatusError(e instanceof Error ? e.message : "Network error"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selected, project, localKey]);

  const refresh = () => setLocalKey((k) => k + 1);

  /** Run an action; owner-only ones fail with the server's 403 when this browser isn't signed in as the owner. */
  const act = async <T,>(label: string, run: () => Promise<T>, done?: (data: T) => string) => {
    setBusy(true);
    setMessage(null);
    try {
      const data = await run();
      setMessage({ ok: true, text: done ? done(data) : `${label}: done` });
    } catch (e) {
      setMessage({ ok: false, text: `${label}: ${e instanceof Error ? e.message : "network error"}` });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const merge = async () => {
    if (!status) return;
    setConfirming(false);
    await act(
      "Merge",
      () => mergePr(project, status.number, status.headSha, reviewer || "owner"),
      (data) => `Merged #${status.number} as ${data.record?.resultSha ? shortSha(data.record.resultSha) : "?"}`,
    );
  };

  const submitReview = async () => {
    if (!status) return;
    const findings = parseFindingLines(findingText, verdict === "request_changes");
    await act("Review", () =>
      submitOwnerReview(project, status.number, { reviewer, headSha: status.headSha, verdict, summary, findings }),
    );
    setSummary("");
    setFindingText("");
  };

  const resolve = async (finding: ReviewFinding) => {
    const note = window.prompt(`Why is this finding resolved?\n\n${finding.text}`);
    if (!note) return;
    await act("Resolve", () => resolveFinding(project, finding.id, { by: reviewer, note }));
  };

  const release = async (hold: MergeHold) => {
    await act("Release", () => releaseHold(project, hold.id, reviewer || "owner"));
  };

  if (info.loading && !info.data) return <div className="loading">Loading reviews...</div>;
  if (info.error && !info.data) return <div className="error">Error: {info.error}</div>;
  const i = info.data;
  if (!i) return null;

  if (!i.enabled) {
    return (
      <div>
        <h2 style={{ marginBottom: "1.5rem" }}>Reviews</h2>
        <div className="card">
          <p>
            Reviews and policy merge are off for this project. Set <code>review.enabled: true</code> and{" "}
            <code>review.merge.gate</code> in its YAML (see docs/configuration.md).
          </p>
          {i.errors.map((e) => (
            <p key={e} className="error" style={{ marginTop: "1rem" }}>
              {e}
            </p>
          ))}
        </div>
      </div>
    );
  }

  const button = mergeButtonState(status, busy);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
        <h2>Reviews</h2>
        <span style={muted}>{i.repo}</span>
        {i.readOnly && <span className="badge badge-neutral">Read-only: no merges</span>}
        <button type="button" style={buttonStyle("plain")} onClick={refresh} disabled={busy}>
          Refresh
        </button>
      </div>

      {message && (
        <div className="card" style={{ borderColor: message.ok ? "var(--success)" : "var(--error)" }}>
          <p style={{ margin: 0, color: message.ok ? "var(--success)" : "var(--error)", whiteSpace: "pre-wrap" }}>
            {message.text}
          </p>
        </div>
      )}

      <div className="card">
        <h3>Open pull requests</h3>
        {prs.error && <p className="error">{prs.error}</p>}
        {prs.data && prs.data.length === 0 && <p style={muted}>No open PRs</p>}
        {prs.data && prs.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Title</th>
                <th>Branch</th>
                <th>Head</th>
                <th>Tier</th>
                <th>Can merge</th>
              </tr>
            </thead>
            <tbody>
              {prs.data.map((pr) => (
                <tr
                  key={pr.number}
                  className="clickable"
                  onClick={() => setSelected(pr.number)}
                  style={selected === pr.number ? { background: "var(--bg-secondary, rgba(59,130,246,0.08))" } : undefined}
                >
                  <td>
                    <span className="badge badge-neutral">#{pr.number}</span>
                  </td>
                  <td>{pr.title}</td>
                  <td>
                    <code>{pr.headRef}</code>
                  </td>
                  <td>
                    <code>{shortSha(pr.headSha)}</code>
                  </td>
                  <td>{pr.tier ? <span className={`badge ${TIER_BADGE[pr.tier]}`}>{pr.tier}</span> : "—"}</td>
                  <td title={pr.reasons.join("\n")}>
                    {pr.canMerge === null ? <span style={muted}>not evaluated</span> : <Flag ok={pr.canMerge} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected !== null && loading && !status && <div className="loading">Evaluating #{selected}...</div>}
      {selected !== null && statusError && <div className="error">Error: {statusError}</div>}

      {status && status.number === selected && (
        <>
          <div className="card">
            <h3>
              #{status.number} {status.title}
            </h3>
            <p style={muted}>
              <code>{status.headRef}</code> → <code>{status.baseRef}</code> at head <code>{status.headSha}</code>
              {status.url && (
                <>
                  {" "}
                  · <a href={status.url} target="_blank" rel="noreferrer">on the host</a>
                </>
              )}
            </p>
            <p style={muted}>
              Author:{" "}
              {status.author
                ? `${status.author.id} (${status.author.kind}${status.author.model ? `, ${status.author.model}` : ""}; ${status.authorSource === "lair" ? "registered" : "from the branch name"})`
                : "unknown"}
              {status.labels.length > 0 && ` · Labels: ${status.labels.join(", ")}`}
            </p>
          </div>

          <div className="card">
            <h3>
              Risk tier <span className={`badge ${TIER_BADGE[status.risk.tier]}`}>{status.risk.tier}</span>
            </h3>
            <p style={muted}>
              {status.risk.size.files} file(s), +{status.risk.size.additions} −{status.risk.size.deletions}; default
              tier {status.risk.defaultTier}
            </p>
            {status.risk.rules.length === 0 ? (
              <p style={muted}>No rule matched: the default tier applies.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Tier</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {status.risk.rules.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <code>{r.id}</code>
                        {r.description && <div style={muted}>{r.description}</div>}
                      </td>
                      <td>
                        <span className={`badge ${TIER_BADGE[r.tier]}`}>{r.tier}</span>
                      </td>
                      <td style={{ fontSize: "0.85rem" }}>{r.reasons.join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
              <h3 style={{ margin: 0 }}>Required reviews</h3>
              <button
                type="button"
                style={buttonStyle("plain", busy)}
                disabled={busy || status.slots.every((s) => s.satisfiedBy !== null)}
                onClick={() => act("Request reviews", () => requestReviews(project, status.number))}
              >
                Request missing reviews
              </button>
            </div>
            {status.slots.length === 0 ? (
              <p style={muted}>None required for the {status.risk.tier} tier.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Required</th>
                    <th>Present at head</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {status.slots.map((s, index) => (
                    <tr key={index}>
                      <td>{s.label}</td>
                      <td>{s.satisfiedBy ? <Flag ok={true} /> : <Flag ok={false} />}</td>
                      <td style={{ fontSize: "0.85rem" }}>{s.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {status.reviews.length > 0 && (
              <table className="table" style={{ marginTop: "1rem" }}>
                <thead>
                  <tr>
                    <th>Reviewer</th>
                    <th>At</th>
                    <th>Verdict</th>
                    <th>Findings</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {status.reviews.map((r) => (
                    <tr key={r.id} style={r.stale || r.superseded ? { opacity: 0.55 } : undefined}>
                      <td>
                        {r.reviewer.id} <span style={muted}>({r.reviewer.kind}{r.reviewer.model ? `, ${r.reviewer.model}` : ""})</span>
                      </td>
                      <td>
                        <code>{shortSha(r.headSha)}</code>
                        {r.stale && <span className="badge badge-neutral" style={{ marginLeft: "0.3rem" }}>stale</span>}
                        {r.superseded && (
                          <span className="badge badge-neutral" style={{ marginLeft: "0.3rem" }}>replaced</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${r.verdict === "approve" ? "badge-success" : "badge-error"}`}>
                          {r.verdict === "approve" ? "approve" : "request changes"}
                        </span>
                      </td>
                      <td>{r.findings.length}</td>
                      <td style={{ fontSize: "0.85rem" }}>{r.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <h3>Findings</h3>
            {status.findings.length === 0 ? (
              <p style={muted}>No findings.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Where</th>
                    <th>Finding</th>
                    <th>Blocking</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {status.findings.map((f) => (
                    <tr key={f.id} style={f.superseded || f.status !== "open" ? { opacity: 0.55 } : undefined}>
                      <td>
                        <span className={`badge ${f.severity === "critical" || f.severity === "high" ? "badge-error" : f.severity === "medium" ? "badge-warning" : "badge-neutral"}`}>
                          {f.severity}
                        </span>
                      </td>
                      <td>
                        <code>{findingLocation(f)}</code>
                      </td>
                      <td style={{ fontSize: "0.85rem" }}>
                        {f.text}
                        <div style={muted}>
                          {f.reviewer.id}
                          {f.rule ? ` · ${f.rule}` : ""} · at {shortSha(f.headSha)}
                        </div>
                      </td>
                      <td>{f.blocking ? "yes" : "no"}</td>
                      <td>
                        {f.superseded ? "replaced" : f.status}
                        {f.resolution && <div style={muted}>{f.resolution}</div>}
                      </td>
                      <td>
                        {f.status === "open" && !f.superseded && (
                          <button type="button" style={buttonStyle("plain", busy)} disabled={busy} onClick={() => resolve(f)}>
                            Resolve
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <h3>Gate at head</h3>
            <table className="table">
              <tbody>
                {status.gate.map((g) => (
                  <tr key={g.name}>
                    <td>
                      <code>{g.name}</code>
                    </td>
                    <td>
                      <span className={`badge ${GATE_BADGE[g.status]}`}>{g.status}</span>
                    </td>
                    <td style={{ fontSize: "0.85rem" }}>
                      {g.url ? (
                        <a href={g.url} target="_blank" rel="noreferrer">
                          {g.detail}
                        </a>
                      ) : (
                        g.detail
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {status.holds.length > 0 && (
            <div className="card">
              <h3>Holds</h3>
              <table className="table">
                <tbody>
                  {status.holds.map((h) => (
                    <tr key={h.id}>
                      <td style={{ fontSize: "0.85rem" }}>
                        {h.reason}
                        <div style={muted}>
                          {h.pr === null ? "every PR" : `PR #${h.pr}`} · by {h.createdBy}
                        </div>
                      </td>
                      <td>
                        <button type="button" style={buttonStyle("plain", busy)} disabled={busy} onClick={() => release(h)}>
                          Release
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card">
            <h3>Merge</h3>
            <table className="table">
              <tbody>
                {status.conditions.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Flag ok={c.ok} />
                    </td>
                    <td>{c.label}</td>
                    <td style={{ fontSize: "0.85rem" }}>{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ ...muted, marginTop: "0.75rem" }}>
              Method: {status.plan.method} ({status.plan.strategy}): {status.plan.reason}
            </p>
            {status.plan.refusal && (
              <p style={{ color: "var(--error)", fontSize: "0.85rem" }}>{status.plan.refusal}</p>
            )}
            {status.plan.warnings.map((w) => (
              <p key={w} style={{ color: "var(--warning)", fontSize: "0.85rem" }}>
                {w}
              </p>
            ))}
            <button
              type="button"
              style={buttonStyle("primary", !button.enabled)}
              disabled={!button.enabled}
              onClick={() => setConfirming(true)}
              title={button.reasons.join("\n")}
            >
              {button.label}
            </button>
            <p style={{ ...muted, marginTop: "0.5rem" }}>
              Merging, reviewing, resolving and releasing a hold need this browser signed in as the owner (see
              Decisions).
            </p>
            {button.reasons.length > 0 && (
              <ul style={{ ...muted, marginTop: "0.5rem" }}>
                {button.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h3>Your review</h3>
            <p style={muted}>
              Binds to head <code>{shortSha(status.headSha)}</code>: a new push makes it stale.
            </p>
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
              <input
                className="command-input"
                style={{ maxWidth: "12rem" }}
                value={reviewer}
                onChange={(e) => setReviewer(e.target.value)}
                placeholder="Your name"
                aria-label="Reviewer name"
              />
              <select
                className="project-select"
                value={verdict}
                onChange={(e) => setVerdict(e.target.value as "approve" | "request_changes")}
                aria-label="Verdict"
              >
                <option value="approve">Approve</option>
                <option value="request_changes">Request changes</option>
              </select>
            </div>
            <textarea
              className="command-input"
              style={{ width: "100%", minHeight: "3rem", marginBottom: "0.5rem" }}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Summary"
              aria-label="Summary"
            />
            <textarea
              className="command-input"
              style={{ width: "100%", minHeight: "4rem", marginBottom: "0.5rem" }}
              value={findingText}
              onChange={(e) => setFindingText(e.target.value)}
              placeholder={"Findings, one per line: path/to/file.ts:42: what is wrong\n(blocking when you request changes)"}
              aria-label="Findings"
            />
            <button
              type="button"
              style={buttonStyle("plain", busy || !reviewer)}
              disabled={busy || !reviewer}
              onClick={submitReview}
            >
              Submit review
            </button>
          </div>
        </>
      )}

      {confirming && status && (
        <>
          <div className="overlay" onClick={() => setConfirming(false)} />
          <div className="detail-panel" style={{ maxWidth: "480px" }}>
            <div className="detail-panel-header">
              <h2>Merge #{status.number}?</h2>
              <button className="detail-panel-close" onClick={() => setConfirming(false)}>
                ×
              </button>
            </div>
            <div className="card">
              <p style={{ margin: 0 }}>{status.title}</p>
              <p style={muted}>
                Head <code>{status.headSha}</code> into <code>{status.baseRef}</code>, {status.plan.method} merge (
                {status.plan.strategy}). Lair re-checks the policy and every published commit's emails first.
              </p>
              {status.plan.warnings.map((w) => (
                <p key={w} style={{ color: "var(--warning)", fontSize: "0.85rem" }}>
                  {w}
                </p>
              ))}
            </div>
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle("plain")} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" style={buttonStyle("danger", busy)} disabled={busy} onClick={merge}>
                Merge
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
