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
import { EmptyState, ErrorState, KeyValues, Loading, OwnerOnlyNotice, Time, useOwnerSignedIn } from "./ui";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";

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
  return (
    <Badge tone={ok ? "success" : "danger"}>
      <span className="visually-hidden">{ok ? "yes" : "no"}</span>
    </Badge>
  );
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
          <Button size="sm" onClick={refresh}>
            Evaluate again
          </Button>
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
          <Badge tone={TIER_BADGE[model.tier]}>{model.tier}</Badge>{" "}
          <Badge tone={status.canMerge ? "badge-success" : "badge-neutral"}>{status.canMerge ? "merge ready" : "waiting"}</Badge>{" "}
          <span className="muted small">
            evaluated <Time iso={status.evaluatedAt} />
          </span>{" "}
          <Button size="sm" onClick={refresh} disabled={busy}>
            Evaluate again
          </Button>
        </>
      }
      onClose={onClose}
    >
      {message && (
        <div className={message.ok ? "card text-success" : "error pre-wrap"} role="status">
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
          <p className="muted small">No rule matched: the default tier ({status.risk.defaultTier}) applies.</p>
        ) : (
          <table className="table">
            <tbody>
              {model.rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    <code>{r.id}</code>
                    {r.description && <div className="muted small">{r.description}</div>}
                  </td>
                  <td>
                    <Badge tone={TIER_BADGE[r.tier]}>{r.tier}</Badge>
                  </td>
                  <td className="small">{r.reasons.join("; ")}</td>
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
            <Button size="sm" disabled={busy} onClick={() => void act("Request reviews", () => requestReviews(project, status.number))}>
              Request missing reviews
            </Button>
          ) : undefined
        }
      >
        {model.slots.length === 0 ? (
          <p className="muted small">None required for the {model.tier} tier.</p>
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
                    <div className="muted small">{s.detail}</div>
                  </td>
                  <td>{s.holder ?? <span className="muted small">nobody yet</span>}</td>
                  <td className="small">
                    {s.request ? (
                      <>
                        <Badge tone={s.request.badge}>{s.request.text}</Badge>
                        <div className="muted small">{s.request.detail}</div>
                      </>
                    ) : (
                      <span className="muted small">not requested</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {status.reviews.length > 0 && (
          <table className="table spaced">
            <thead>
              <tr>
                <th>Review</th>
                <th>Verdict</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {status.reviews.map((r) => (
                <tr key={r.id} className={r.stale || r.superseded ? "faded" : undefined}>
                  <td>
                    {r.reviewer.id} <span className="muted small">({r.reviewer.kind}{r.reviewer.model ? `, ${r.reviewer.model}` : ""})</span>
                    <div className="muted small">
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
                  <td className="small">{r.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DetailSection>

      <DetailSection title={`Findings (${model.openFindings.length} open, ${model.blockingFindings} blocking)`}>
        {status.findings.length === 0 ? (
          <p className="muted small">No findings.</p>
        ) : (
          <table className="table">
            <tbody>
              {status.findings.map((f) => (
                <tr key={f.id} className={f.superseded || f.status !== "open" ? "faded" : undefined}>
                  <td>
                    <span className={`badge ${f.severity === "critical" || f.severity === "high" ? "badge-error" : f.severity === "medium" ? "badge-warning" : "badge-neutral"}`}>
                      {f.severity}
                    </span>
                    {f.blocking && <div className="muted small">blocking</div>}
                  </td>
                  <td className="small">
                    <code>{findingLocation(f)}</code> {f.text}
                    <div className="muted small">
                      {f.reviewer.id}
                      {f.rule ? ` · ${f.rule}` : ""} · {f.superseded ? "replaced" : f.status}
                      {f.resolution ? ` · ${f.resolution}` : ""}
                    </div>
                  </td>
                  <td>
                    {owner && f.status === "open" && !f.superseded && (
                      <Button size="sm" disabled={busy} onClick={() => resolve(f)}>
                        Resolve
                      </Button>
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
                  <Badge tone={GATE_BADGE[g.status]}>{g.status}</Badge>
                </td>
                <td className="small">
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
                {h.reason} <span className="muted small">({h.pr === null ? "every PR" : `PR #${h.pr}`}, by {h.createdBy}, <Time iso={h.createdAt} />)</span>{" "}
                {owner && (
                  <Button size="sm" disabled={busy} onClick={() => release(h)}>
                    Release
                  </Button>
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
                <td className="small">{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Method: {status.plan.method} ({status.plan.strategy}): {status.plan.reason}
        </p>
        {status.plan.refusal && <p className="text-danger small">{status.plan.refusal}</p>}
        {status.plan.warnings.map((w) => (
          <p key={w} className="text-warning small">
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
              <Button size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={merge}>
                Merge
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={!model.merge.enabled || !owner}
            title={model.merge.reasons.join("\n") || (owner ? undefined : "Sign in as the owner from Decisions first")}
            onClick={() => setConfirming(true)}
          >
            {model.merge.label}
          </Button>
        )}
        {model.merge.reasons.length > 0 && (
          <ul className="muted small mt-2">
            {model.merge.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </DetailSection>

      {owner && (
        <DetailSection title="Your review">
          <p className="muted small">
            Binds to head <code>{shortSha(status.headSha)}</code>: a new push makes it stale.
          </p>
          <div className="button-row">
            <input className="input" value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="Your name" aria-label="Reviewer name" />
            <Select value={verdict} onChange={(e) => setVerdict(e.target.value as "approve" | "request_changes")} aria-label="Verdict">
              <option value="approve">Approve</option>
              <option value="request_changes">Request changes</option>
            </Select>
          </div>
          <textarea className="input textarea" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Summary" aria-label="Summary" />
          <textarea
            className="input textarea"
            value={findingText}
            onChange={(e) => setFindingText(e.target.value)}
            placeholder={"Findings, one per line: path/to/file.ts:42: what is wrong\n(blocking when you request changes)"}
            aria-label="Findings"
          />
          <Button size="sm" disabled={busy || !reviewer} onClick={submitReview}>
            Submit review
          </Button>
        </DetailSection>
      )}
    </DetailPanel>
  );
}
