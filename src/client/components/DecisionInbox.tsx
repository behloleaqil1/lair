/**
 * The Decision Inbox (the Decisions section's first tab): the questions only
 * a human can answer (pricing, legal, spend, accounts, credentials,
 * go/no-go, escalations, holds only the owner lifts), from every project, in
 * one table: the open action items first by urgency, then the open notices
 * (labelled FYI: for information, nothing to choose, never counted in the
 * badge), then the closed ones; a row opens the decision (#/decisions/<id>): what it blocks and
 * why, its options with their consequences, the recommended one, then the
 * answer form (or, once closed, how it ended and its history).
 *
 * Spend and go/no-go answers go through a confirmation step. A credentials
 * decision has a password field and no note: the value goes to the server's
 * secret store with the answer and is never shown again (the API has none to
 * give). Answering works only once this browser is signed in as the owner
 * (UnlockAnswering, or the setup link the nav badge picks up; owner-session.ts).
 */
import { useEffect, useId, useRef, useState } from "react";
import type { Decision, DecisionAuditEntry, DecisionCounts, DecisionOption } from "../../shared/decision-types";
import {
  KIND_LABELS,
  answerBody,
  badgeCount,
  confirmationText,
  decisionSummary,
  expiryText,
  getDecision,
  inboxOrder,
  isNoticeDecision,
  needsConfirmation,
  outcomeText,
  postAnswer,
} from "../decisions-api";
import { sessionSurvivesReload, signIn, tokenFromHash } from "../owner-session";
import { OwnerSessions } from "./OwnerSessions";
import { PolicyAgreement } from "./PolicyAgreement";
import { DataTable, type Column } from "./DataTable";
import { DetailPanel } from "./DetailPanel";
import { Time } from "./ui";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

const KIND_BADGE: Record<string, string> = {
  spend: "badge-error",
  legal: "badge-error",
  credentials: "badge-error",
  go_no_go: "badge-error",
  security: "badge-error",
  account: "badge-warning",
  pricing: "badge-warning",
  escalation: "badge-warning",
  other: "badge-neutral",
};

function time(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export type CardStage = "choose" | "confirm";

export interface DecisionCardViewProps {
  decision: Decision;
  now: number;
  /** Where a credentials answer's secret goes */
  secretStore: string;
  stage: CardStage;
  /** The option waiting for confirmation */
  pending?: DecisionOption;
  /** A secret has been typed (enables the option that supplies it) */
  hasSecret: boolean;
  /** Answering is unlocked in this browser */
  canAnswer: boolean;
  submitting: boolean;
  error: string | null;
  onChoose: (option: DecisionOption) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onNote: (note: string) => void;
  onSecret: (secret: string) => void;
}

/** One open decision. Stateless: DecisionCard holds the state. */
export function DecisionCardView(p: DecisionCardViewProps) {
  const { decision } = p;
  const expiry = expiryText(decision, p.now);
  const recommended = decision.options.find((o) => o.id === decision.recommended.optionId);
  const confirmId = useId();
  return (
    <div className="card" data-decision={decision.id}>
      <div className="decision-head">
        <Badge tone={KIND_BADGE[decision.kind] ?? "badge-neutral"}>{KIND_LABELS[decision.kind]}</Badge>
        {isNoticeDecision(decision) && <Badge tone="neutral">FYI</Badge>}
        <h3 className="decision-title">{decision.title}</h3>
      </div>
      {isNoticeDecision(decision) && (
        <div className="muted small" data-attention="notice">
          For your information: nothing waits on your answer. It goes away by itself once it no longer applies.
        </div>
      )}
      <div className="muted small">
        {decision.project} · raised by <code>{decision.source.module}</code> ({decision.source.ref}) ·{" "}
        {time(decision.createdAt)}
        {decision.raisedVia === "http" && (
          <span data-raised-via="http"> · over HTTP, so that module name is only what the caller said</span>
        )}
      </div>
      {expiry && (
        <div className={`small ${decision.overdue ? "text-danger" : "text-warning"}`}>{expiry}</div>
      )}

      <p className="decision-context">{decision.context}</p>
      <DecisionStructureLine decision={decision} />
      {/* Links are text to copy, never clickable: a decision's links come from whoever raised it */}
      {decision.links.length > 0 && (
        <ul className="muted small decision-links" data-links="text">
          {decision.links.map((link) => (
            <li key={link.url}>
              {link.label}: <code>{link.url}</code>{" "}
              <Button
                size="sm"
                onClick={() => void navigator.clipboard?.writeText(link.url)}
                title="Copy the address, then check it before you open it"
              >
                Copy
              </Button>
            </li>
          ))}
        </ul>
      )}
      {decision.blocks.length > 0 && (
        <div className="muted small">
          Waiting on this:{" "}
          {decision.blocks.map((ref) => (
            <code key={ref} className="decision-ref">
              {ref}
            </code>
          ))}
        </div>
      )}
      <div className="decision-recommended">
        <strong>Recommended: {recommended?.label ?? decision.recommended.optionId}.</strong>{" "}
        <span className="muted small">{decision.recommended.reasoning}</span>
      </div>

      {decision.kind === "credentials" && (
        <label className="label-stack">
          <span className="muted small">
            Secret for <code>{decision.secretName}</code>. It goes to the secret store ({p.secretStore}) and is
            never shown again.
          </span>
          <input
            type="password"
            autoComplete="new-password"
            name={`secret-${decision.id}`}
            onChange={(e) => p.onSecret(e.target.value)}
            disabled={p.submitting}
            className="input"
          />
        </label>
      )}
      {/* No note on credentials decisions: a secret could end up in it */}
      {decision.kind !== "credentials" && (
        <textarea
          aria-label="Note"
          placeholder="Note (optional)"
          rows={2}
          onChange={(e) => p.onNote(e.target.value)}
          disabled={p.submitting}
          className="input textarea"
        />
      )}

      {p.stage === "confirm" && p.pending ? (
        <div className="callout callout-warning decision-confirm" role="alertdialog" aria-labelledby={confirmId}>
          <Icon name="alert" className="callout-icon" />
          <div className="callout-body">
            <p id={confirmId} className="callout-title text-warning">
              Confirm your answer
            </p>
            <p>{confirmationText(decision, p.pending)}</p>
            <div className="button-row">
              <Button onClick={p.onCancel} disabled={p.submitting}>
                Cancel
              </Button>
              <Button variant="primary" onClick={p.onConfirm} disabled={p.submitting}>
                {p.submitting ? "Sending..." : `Confirm: ${p.pending.label}`}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="decision-options">
          {decision.options.map((option) => {
            const isRecommended = option.id === decision.recommended.optionId;
            const needsSecret = option.suppliesSecret === true && !p.hasSecret;
            const blockedBy = !p.canAnswer
              ? "Unlock answering first"
              : needsSecret
                ? "Enter the secret first"
                : undefined;
            return (
              <div key={option.id} className="decision-option">
                <Button
                  variant={isRecommended ? "primary" : "secondary"}
                  onClick={() => p.onChoose(option)}
                  disabled={p.submitting || blockedBy !== undefined}
                  title={blockedBy}
                >
                  {option.label}
                  {isRecommended ? " (recommended)" : ""}
                </Button>
                <span className="muted small">
                  {option.consequences}
                  {option.effect ? ` (${option.effect.replace("_", " ")})` : ""}
                  {decision.defaultOptionId === option.id ? " Applied if nobody answers before it expires." : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {p.error && (
        <div className="error decision-error" role="alert">
          {p.error}
        </div>
      )}
      <AuditToggle id={decision.id} />
    </div>
  );
}

/** An open decision with its answer form. The secret is kept in a ref, never in rendered state. */
export function DecisionCard({
  decision,
  now,
  secretStore,
  canAnswer,
  onAnswered,
}: {
  decision: Decision;
  now: number;
  secretStore: string;
  canAnswer: boolean;
  onAnswered: () => void;
}) {
  const [stage, setStage] = useState<CardStage>("choose");
  const [pending, setPending] = useState<DecisionOption | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSecret, setHasSecret] = useState(false);
  const note = useRef("");
  const secret = useRef("");

  const send = async (option: DecisionOption) => {
    setSubmitting(true);
    setError(null);
    try {
      await postAnswer(
        decision.id,
        answerBody(decision, { optionId: option.id, note: note.current, secret: secret.current }),
      );
      secret.current = "";
      onAnswered();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the answer");
      setStage("choose");
      setPending(undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DecisionCardView
      decision={decision}
      now={now}
      secretStore={secretStore}
      stage={stage}
      pending={pending}
      hasSecret={hasSecret}
      canAnswer={canAnswer}
      submitting={submitting}
      error={error}
      onChoose={(option) => {
        if (needsConfirmation(decision.kind)) {
          setPending(option);
          setStage("confirm");
        } else {
          void send(option);
        }
      }}
      onConfirm={() => {
        if (pending) void send(pending);
      }}
      onCancel={() => {
        setStage("choose");
        setPending(undefined);
      }}
      onNote={(value) => {
        note.current = value;
      }}
      onSecret={(value) => {
        secret.current = value;
        setHasSecret(value.trim() !== "");
      }}
    />
  );
}

/** "History": the decision's audit trail, loaded when opened. */
function AuditToggle({ id }: { id: string }) {
  const [entries, setEntries] = useState<DecisionAuditEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getDecision(id)
      .then((d) => {
        if (!cancelled) setEntries(d.audit ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the history");
      });
    return () => {
      cancelled = true;
    };
  }, [id, open]);

  return (
    <div className="decision-history">
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide history" : "History"}
      </Button>
      {open && error && <div className="error">{error}</div>}
      {open && entries && <AuditList entries={entries} />}
    </div>
  );
}

export function AuditList({ entries }: { entries: DecisionAuditEntry[] }) {
  return (
    <ul className="muted small decision-audit">
      {entries.map((entry, i) => (
        <li key={i}>
          {time(entry.at)} <code>{entry.action}</code> by {entry.actor}: {entry.detail}
        </li>
      ))}
    </ul>
  );
}

/**
 * Shown until this browser is signed in as the owner: the token from
 * data/owner.token (or the setup link the server printed at its first
 * start) gets an owner session, kept in this origin's localStorage.
 */
export function UnlockAnswering({ onUnlock }: { onUnlock: (token: string) => Promise<void> }) {
  const token = useRef("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      await onUnlock(token.current);
      token.current = "";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not unlock answering");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card card-warning" data-unlock="answering">
      <h3>Unlock answering</h3>
      <p className="muted small">
        Only you answer decisions, so this browser has to sign in as the owner, once, with the owner token Lair keeps
        in <code>data/owner.token</code>. Open the setup link the server printed when it first started, or paste the
        token here.
        {!sessionSurvivesReload && (
          <>
            {" "}
            Under <code>npm run dev</code> the session stays in this page only (the dev server also serves the
            repository's files), so sign in again after a reload.
          </>
        )}
      </p>
      <input
        type="password"
        autoComplete="off"
        name="owner-token"
        aria-label="Owner token"
        placeholder="Owner token"
        onChange={(e) => {
          token.current = e.target.value;
        }}
        disabled={busy}
        className="input"
      />
      <div className="button-row">
        <Button variant="primary" onClick={() => void unlock()} disabled={busy}>
          {busy ? "Unlocking..." : "Unlock answering"}
        </Button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

const DECISION_COLUMNS: Column<Decision>[] = [
  {
    key: "kind",
    label: "Kind",
    sort: (d) => KIND_LABELS[d.kind],
    render: (d) => <Badge tone={KIND_BADGE[d.kind] ?? "badge-neutral"}>{KIND_LABELS[d.kind]}</Badge>,
  },
  {
    key: "title",
    label: "Decision",
    sort: (d) => d.title,
    render: (d) => (
      <>
        {d.title}
        <div className="muted small">
          {d.project} · {d.source.module}
        </div>
      </>
    ),
  },
  { key: "raised", label: "Raised", sort: (d) => d.createdAt, render: (d) => <Time iso={d.createdAt} /> },
  {
    key: "status",
    label: "Status",
    sort: (d) => (d.status === "open" ? (isNoticeDecision(d) ? 2 : d.overdue ? 0 : 1) : 3),
    render: (d) =>
      d.status === "open" ? (
        isNoticeDecision(d) ? (
          <span className="badge badge-neutral" data-attention="notice">
            FYI
          </span>
        ) : (
          <Badge tone={d.overdue ? "badge-error" : "badge-warning"}>{d.overdue ? "overdue" : "needs you"}</Badge>
        )
      ) : (
        <span className="muted small">{outcomeText(d)}</span>
      ),
  },
];

/** A decision's detail: its full context and options, then the answer form (open) or how it ended (closed). */
export function DecisionDetail({
  decision,
  now,
  secretStore,
  answering,
  onAnswered,
  onClose,
}: {
  decision: Decision;
  now: number;
  secretStore: string;
  answering: boolean;
  onAnswered: () => void;
  onClose: () => void;
}) {
  return (
    <DetailPanel
      title={decision.title}
      subtitle={
        <>
          <Badge tone={KIND_BADGE[decision.kind] ?? "badge-neutral"}>{KIND_LABELS[decision.kind]}</Badge>{" "}
          <span className="muted small">
            {decision.status === "open" ? "open" : decision.status} · raised <Time iso={decision.createdAt} now={now} />
          </span>
        </>
      }
      onClose={onClose}
    >
      {decision.status === "open" ? (
        <DecisionCard decision={decision} now={now} secretStore={secretStore} canAnswer={answering} onAnswered={onAnswered} />
      ) : (
        <div className="card" data-decision={decision.id}>
          <div className="muted small">
            {decision.project} · raised by <code>{decision.source.module}</code> ({decision.source.ref})
          </div>
          <p className="decision-context">{decision.context}</p>
          <DecisionStructureLine decision={decision} />
          <ul className="muted small decision-links">
            {decision.options.map((o) => (
              <li key={o.id}>
                <strong>{o.label}</strong>: {o.consequences}{o.effect ? ` (${o.effect.replace("_", " ")})` : ""}
              </li>
            ))}
          </ul>
          <p>
            <strong>Outcome:</strong> {outcomeText(decision)}
            {decision.closedAt && (
              <span className="muted small">
                {" "}
                (<Time iso={decision.closedAt} now={now} />)
              </span>
            )}
          </p>
          {decision.answer?.note && <p className="muted small">Note: {decision.answer.note}</p>}
          <AuditToggle id={decision.id} />
        </div>
      )}
    </DetailPanel>
  );
}

export function DecisionInboxView({
  decisions,
  secretStore,
  now,
  answering,
  onUnlock,
  onSignedOut = () => undefined,
  onAnswered,
  selected = null,
  onOpen = () => undefined,
}: {
  decisions: Decision[];
  secretStore: string;
  now: number;
  /** This browser is signed in as the owner */
  answering: boolean;
  onUnlock: (token: string) => Promise<void>;
  /** This browser signed itself out (in the signed-in browsers list) */
  onSignedOut?: () => void;
  onAnswered: () => void;
  /** The decision whose detail is open */
  selected?: string | null;
  /** Open a decision's detail (null closes it) */
  onOpen?: (id: string | null) => void;
}) {
  // Action items first, then the notices (FYI), then the closed ones
  const { action, notices, closed } = inboxOrder(decisions);
  const shown = [...action, ...notices, ...closed.slice(0, 50)];
  const current = selected ? (decisions.find((d) => d.id === selected) ?? null) : null;
  return (
    <div>
      <p className="muted small section-intro">
        {`Decisions (${action.length} ${action.length === 1 ? "needs" : "need"} you${notices.length > 0 ? `, ${notices.length} FYI` : ""})`}
        : only what Lair can&apos;t decide for you: pricing, legal,
        spend, accounts, credentials, go/no-go, holds only you can lift, and problems its playbooks couldn&apos;t fix. FYI
        items ask nothing and go away by themselves. Every project&apos;s are here.
      </p>

      {answering ? <OwnerSessions onSignedOut={onSignedOut} /> : <UnlockAnswering onUnlock={onUnlock} />}
      {answering && <PolicyAgreement />}

      {action.length === 0 && (
        <div className="card" data-empty="needs-you">
          <p className="muted small">Nothing needs you.</p>
        </div>
      )}

      <div className="card">
        <DataTable
          label="Decisions"
          columns={DECISION_COLUMNS}
          rows={shown}
          rowKey={(d) => d.id}
          onOpen={(d) => onOpen(d.id)}
          selected={selected}
          empty={<p className="muted small">No decisions yet: modules raise them here when they need you.</p>}
        />
      </div>

      {selected && current && (
        <DecisionDetail
          decision={current}
          now={now}
          secretStore={secretStore}
          answering={answering}
          onAnswered={onAnswered}
          onClose={() => onOpen(null)}
        />
      )}
      {selected && !current && (
        <DetailPanel title="Decision" onClose={() => onOpen(null)}>
          <p className="muted small">
            No decision <code>{selected}</code> in the latest {decisions.length}: it may be older, or the link may be wrong.
          </p>
        </DetailPanel>
      )}
    </div>
  );
}

/** The nav's "needs you" count: open action items only (notices never count); red while any is overdue. */
export function DecisionCountBadge(counts: Pick<DecisionCounts, "open" | "overdue"> & Partial<DecisionCounts>) {
  const { count, overdue } = badgeCount(counts);
  if (count <= 0) return null;
  return (
    <span
      className={`badge count-badge ${overdue ? "badge-error" : "badge-warning"}`}
      title={`${count} ${count === 1 ? "thing needs" : "things need"} you${overdue ? `, ${counts.overdue} overdue` : ""}`}
    >
      {count}
      <span className="visually-hidden"> need you</span>
    </span>
  );
}

/**
 * The nav badge. It is on every page, so it also takes the setup link's
 * token (`#owner-token=...`): it signs this browser in and removes the token
 * from the address bar and the history.
 */
export function DecisionsBadge({ refreshKey }: { refreshKey: number }) {
  const [counts, setCounts] = useState<DecisionCounts | null>(null);

  useEffect(() => {
    const token = tokenFromHash(window.location.hash);
    if (!token) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    signIn(token).catch((e: unknown) => console.warn("Could not sign this browser in:", e));
  }, []);

  useEffect(() => {
    let cancelled = false;
    decisionSummary()
      .then((s) => {
        if (!cancelled) setCounts({ open: s.open, overdue: s.overdue, action: s.action, notices: s.notices });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return counts ? <DecisionCountBadge {...counts} /> : null;
}

/**
 * What a module recorded for rules to read: the class, the evidence code and
 * its facts, under the prose. Nothing is shown for a decision without them.
 */
export function DecisionStructureLine({ decision }: { decision: Decision }) {
  if (!decision.class || !decision.evidence) return null;
  const { evidence } = decision;
  const facts = Object.entries(evidence.facts)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(", ");
  return (
    <p className="muted small" data-decision-class={decision.class}>
      Class <code>{decision.class}</code>
      {decision.classKnown === false ? " (not in the policy table)" : ""} · evidence <code>{evidence.code}</code>
      {facts ? ` (${facts})` : ""} · cause {evidence.cause_cleared ? "cleared" : "not cleared"}
      {evidence.linked_issue !== null ? ` · issue #${evidence.linked_issue}` : ""}
    </p>
  );
}
