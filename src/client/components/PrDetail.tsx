/**
 * A PR's detail (#/prs/<n>). With the review module on: its risk tier and
 * the rules that set it, the required reviews and who holds each slot, the
 * reviews, the findings, the gate at the head, holds, the merge conditions
 * and the merge (the owner's, after a confirmation, at the head shown), and
 * the owner's own review. The evaluation calls the git host several times,
 * so it refreshes on "Evaluate again" and after an action, not on the
 * dashboard's timer. Without the review module: what the git host says.
 */
import { useEffect, useState } from "react";
import type { PullRequest } from "../../shared/types";
import type { MergeHold, PrReviewStatus, ReviewFinding } from "../../shared/review-types";
import { mergePr, prStatus, releaseHold, requestReviews, resolveFinding, submitOwnerReview } from "../review-api";
import { GATE_BADGE, TIER_BADGE, findingLocation, parseFindingLines, shortSha } from "../review-view";
import { prDetail } from "../pr-view";
import { linkTo } from "../router";
import { DetailPanel, DetailSection } from "./DetailPanel";
import { EmptyState, ErrorState, KeyValues, Loading, OwnerOnlyNotice, Time, muted, useOwnerSignedIn } from "./ui";

interface Props {
  /** null: the URL's id is not a PR number */
  number: number | null;
  raw: string;
  project: string;
  refreshKey: number;
  reviewOn: boolean;
  readOnly: boolean;
  /** The git host's PR, without the review module */
  hostPr: PullRequest | null;
  onClose: () => void;
}

function Flag({ ok }: { ok: boolean }) {
  return <span className={`badge ${ok ? "badge-success" : "badge-error"}`}>{ok ? "✓" : "✗"}</span>;
}

export function PrDetail({ number, raw, project, refreshKey, reviewOn, readOnly, hostPr, onClose }: Props) {
  const signedIn = useOwnerSignedIn(refreshKey);
  const [status, setStatus] = useState<PrReviewStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localKey, setLocalKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reviewer, setReviewer] = useState("owner");
  const [verdict, setVerdict] = useState<"approve" | "request_changes">("approve");
  const [summary, setSummary] = useState("");
  const [findingText, setFindingText] = useState("");

  useEffect(() => {
    if (!reviewOn || number === null) return;
    let cancelled = false;
    setError(null);
    prStatus(project, number)
      .then((data) => !cancelled && setStatus(data))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Network error"));
    return () => {
      cancelled = true;
    };
  }, [reviewOn, number, project, localKey]);

  if (number === null) {
    return (
      <DetailPanel title={`PR ${raw}`} onClose={onClose}>
        <EmptyState title="Not a pull request number">PR links look like #/prs/42.</EmptyState>
      </DetailPanel>
    );
  }

  if (!reviewOn) {
    return (
      <DetailPanel title={hostPr ? `#${number} ${hostPr.title}` : `#${number}`} onClose={onClose}>
        {hostPr ? (
          <KeyValues
            rows={[
              ["Branch", <code key="b">{hostPr.headRefName}</code>],
              ["Head", <code key="h">{hostPr.headRefOid}</code>],
              ["Mergeable", hostPr.mergeable],
              ["Updated", <Time key="u" iso={hostPr.updatedAt} />],
              ["Gate", hostPr.latestGate ? <a href={linkTo("gates", hostPr.latestGate.id, "results")}>{hostPr.mergeReady ? "passed" : "not passed"}: {hostPr.latestGate.id}</a> : "no gate result at this head"],
            ]}
          />
        ) : (
          <Loading what={`#${number}`} />
        )}
        <EmptyState title="No review policy for this project">
          Turn on review (review.enabled: true) for risk tiers, required reviews, findings and the merge button.
        </EmptyState>
      </DetailPanel>
    );
  }

  const refresh = () => setLocalKey((k) => k + 1);
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

  if (!status || status.number !== number) {
    return (
      <DetailPanel title={`#${number}`} onClose={onClose}>
        {error ? <ErrorState what={`#${number}`} error={error} hint="The review module reads it from the git host; check its token, then Evaluate again." /> : <Loading what={`#${number} (the review module asks the git host)`} />}
        {error && (
          <button type="button" className="small-button" onClick={refresh}>
            Evaluate again
          </button>
        )}
      </DetailPanel>
    );
  }

  const model = prDetail(status, busy);
  const owner = signedIn === true && !readOnly;
  const merge = () => {
    setConfirming(false);
    void act(
      "Merge",
      () => mergePr(project, status.number, status.headSha, reviewer || "owner"),
      (data) => `Merged #${status.number} as ${data.record?.resultSha ? shortSha(data.record.resultSha) : "?"}`,
    );
  };
  const resolve = (finding: ReviewFinding) => {
    const note = window.prompt(`Why is this finding resolved?\n\n${finding.text}`);
    if (!note) return;
    void act("Resolve", () => resolveFinding(project, finding.id, { by: reviewer || "owner", note }));
  };
  const release = (hold: MergeHold) => void act("Release", () => releaseHold(project, hold.id, reviewer || "owner"));
  const submitReview = () => {
    const findings = parseFindingLines(findingText, verdict === "request_changes");
    void act("Review", () => submitOwnerReview(project, status.number, { reviewer, headSha: status.headSha, verdict, summary, findings })).then(() => {
      setSummary("");
      setFindingText("");
    });
  };

  return (
    <DetailPanel
      title={`#${status.number} ${status.title}`}
      subtitle={
        <>
          <span className={`badge ${TIER_BADGE[model.tier]}`}>{model.tier}</span>{" "}
          <span className={`badge ${status.canMerge ? "badge-success" : "badge-neutral"}`}>{status.canMerge ? "merge ready" : "waiting"}</span>{" "}
          <span style={muted}>
            evaluated <Time iso={status.evaluatedAt} />
          </span>{" "}
          <button type="button" className="small-button" onClick={refresh} disabled={busy}>
            Evaluate again
          </button>
        </>
      }
      onClose={onClose}
    >
      {message && (
        <div className={message.ok ? "card" : "error"} role="status" style={message.ok ? { color: "var(--success)" } : { whiteSpace: "pre-wrap" }}>
          {message.text}
        </div>
      )}
      {!readOnly && signedIn === false && <OwnerOnlyNotice text="Merging, reviewing, resolving findings and releasing holds are the owner's." />}

      <KeyValues
        rows={[
          ["Branch", <span key="b"><code>{status.headRef}</code> → <code>{status.baseRef}</code></span>],
          ["Head", <code key="h">{status.headSha}</code>],
          ["Author", model.author],
          ["Labels", status.labels.length > 0 ? status.labels.join(", ") : null],
          ["Size", model.size],
          ["On the host", status.url ? <a href={status.url} target="_blank" rel="noreferrer">{status.url}</a> : null],
        ]}
      />

      <DetailSection title="Risk tier">
        {model.rules.length === 0 ? (
          <p style={muted}>No rule matched: the default tier ({status.risk.defaultTier}) applies.</p>
        ) : (
          <table className="table">
            <tbody>
              {model.rules.map((r) => (
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
      </DetailSection>

      <DetailSection
        title="Required reviews"
        actions={
          owner && !model.reviewsComplete ? (
            <button type="button" className="small-button" disabled={busy} onClick={() => void act("Request reviews", () => requestReviews(project, status.number))}>
              Request missing reviews
            </button>
          ) : undefined
        }
      >
        {model.slots.length === 0 ? (
          <p style={muted}>None required for the {model.tier} tier.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Held by</th>
                <th>Request</th>
              </tr>
            </thead>
            <tbody>
              {model.slots.map((s, i) => (
                <tr key={i}>
                  <td>
                    <Flag ok={s.filled} /> {s.label}
                    <div style={muted}>{s.detail}</div>
                  </td>
                  <td>{s.holder ?? <span style={muted}>nobody yet</span>}</td>
                  <td style={{ fontSize: "0.85rem" }}>
                    {s.request ? (
                      <>
                        <span className={`badge ${s.request.badge}`}>{s.request.text}</span>
                        <div style={muted}>{s.request.detail}</div>
                      </>
                    ) : (
                      <span style={muted}>not requested</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {status.reviews.length > 0 && (
          <table className="table" style={{ marginTop: "0.75rem" }}>
            <thead>
              <tr>
                <th>Review</th>
                <th>Verdict</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {status.reviews.map((r) => (
                <tr key={r.id} style={r.stale || r.superseded ? { opacity: 0.55 } : undefined}>
                  <td>
                    {r.reviewer.id} <span style={muted}>({r.reviewer.kind}{r.reviewer.model ? `, ${r.reviewer.model}` : ""})</span>
                    <div style={muted}>
                      at <code>{shortSha(r.headSha)}</code>, <Time iso={r.createdAt} />
                      {r.stale ? " · stale" : ""}
                      {r.superseded ? " · replaced" : ""}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${r.verdict === "approve" ? "badge-success" : "badge-error"}`}>
                      {r.verdict === "approve" ? "approve" : "request changes"}
                    </span>
                  </td>
                  <td style={{ fontSize: "0.85rem" }}>{r.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DetailSection>

      <DetailSection title={`Findings (${model.openFindings.length} open, ${model.blockingFindings} blocking)`}>
        {status.findings.length === 0 ? (
          <p style={muted}>No findings.</p>
        ) : (
          <table className="table">
            <tbody>
              {status.findings.map((f) => (
                <tr key={f.id} style={f.superseded || f.status !== "open" ? { opacity: 0.55 } : undefined}>
                  <td>
                    <span className={`badge ${f.severity === "critical" || f.severity === "high" ? "badge-error" : f.severity === "medium" ? "badge-warning" : "badge-neutral"}`}>
                      {f.severity}
                    </span>
                    {f.blocking && <div style={muted}>blocking</div>}
                  </td>
                  <td style={{ fontSize: "0.85rem" }}>
                    <code>{findingLocation(f)}</code> {f.text}
                    <div style={muted}>
                      {f.reviewer.id}
                      {f.rule ? ` · ${f.rule}` : ""} · {f.superseded ? "replaced" : f.status}
                      {f.resolution ? ` · ${f.resolution}` : ""}
                    </div>
                  </td>
                  <td>
                    {owner && f.status === "open" && !f.superseded && (
                      <button type="button" className="small-button" disabled={busy} onClick={() => resolve(f)}>
                        Resolve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DetailSection>

      <DetailSection title="Gate at head">
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
      </DetailSection>

      {model.holds.length > 0 && (
        <DetailSection title="Holds">
          <ul className="plain-list">
            {model.holds.map((h) => (
              <li key={h.id}>
                {h.reason} <span style={muted}>({h.pr === null ? "every PR" : `PR #${h.pr}`}, by {h.createdBy}, <Time iso={h.createdAt} />)</span>{" "}
                {owner && (
                  <button type="button" className="small-button" disabled={busy} onClick={() => release(h)}>
                    Release
                  </button>
                )}
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      <DetailSection title="Merge">
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
        <p style={muted}>
          Method: {status.plan.method} ({status.plan.strategy}): {status.plan.reason}
        </p>
        {status.plan.refusal && <p style={{ color: "var(--error)", fontSize: "0.85rem" }}>{status.plan.refusal}</p>}
        {status.plan.warnings.map((w) => (
          <p key={w} style={{ color: "var(--warning)", fontSize: "0.85rem" }}>
            {w}
          </p>
        ))}
        {confirming ? (
          <div className="confirm" role="alertdialog" aria-label={`Merge #${status.number}?`}>
            <p>
              Merge <code>{shortSha(status.headSha)}</code> into <code>{status.baseRef}</code> ({status.plan.method}, {status.plan.strategy})?
              Lair checks the policy and every published commit&apos;s emails again first.
            </p>
            <div className="button-row">
              <button type="button" className="small-button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="small-button danger" disabled={busy} onClick={merge}>
                Merge
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="small-button primary"
            disabled={!model.merge.enabled || !owner}
            title={model.merge.reasons.join("\n") || (owner ? undefined : "Sign in as the owner from Decisions first")}
            onClick={() => setConfirming(true)}
          >
            {model.merge.label}
          </button>
        )}
        {model.merge.reasons.length > 0 && (
          <ul style={{ ...muted, marginTop: "0.5rem" }}>
            {model.merge.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </DetailSection>

      {owner && (
        <DetailSection title="Your review">
          <p style={muted}>
            Binds to head <code>{shortSha(status.headSha)}</code>: a new push makes it stale.
          </p>
          <div className="button-row">
            <input className="command-input" value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="Your name" aria-label="Reviewer name" />
            <select className="project-select" value={verdict} onChange={(e) => setVerdict(e.target.value as "approve" | "request_changes")} aria-label="Verdict">
              <option value="approve">Approve</option>
              <option value="request_changes">Request changes</option>
            </select>
          </div>
          <textarea className="command-input block" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Summary" aria-label="Summary" />
          <textarea
            className="command-input block"
            value={findingText}
            onChange={(e) => setFindingText(e.target.value)}
            placeholder={"Findings, one per line: path/to/file.ts:42: what is wrong\n(blocking when you request changes)"}
            aria-label="Findings"
          />
          <button type="button" className="small-button" disabled={busy || !reviewer} onClick={submitReview}>
            Submit review
          </button>
        </DetailSection>
      )}
    </DetailPanel>
  );
}
