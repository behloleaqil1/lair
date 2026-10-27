/**
 * The Decision Inbox (the Decisions section's first tab): the questions only
 * a human can answer (pricing, legal, spend, accounts, credentials,
 * go/no-go, escalations), from every project, open first by urgency, in one
 * table; a row opens the decision (#/decisions/<id>): what it blocks and
 * why, its options with their consequences, the recommended one, then the
 * answer form (or, once closed, how it ended and its history).
 *
 * Spend and go/no-go answers go through a confirmation step. A credentials
 * decision has a password field and no note: the value goes to the server's
 * secret store with the answer and is never shown again (the API has none to
 * give). Answering works only once this browser is signed in as the owner
 * (UnlockAnswering, or the setup link the nav badge picks up; owner-session.ts).
 */
import { useEffect, useRef, useState } from "react";
import type { Decision, DecisionAuditEntry, DecisionCounts, DecisionOption } from "../../shared/decision-types";
import {
  KIND_LABELS,
  answerBody,
  confirmationText,
  decisionSummary,
  expiryText,
  getDecision,
  needsConfirmation,
  outcomeText,
  postAnswer,
} from "../decisions-api";
import { sessionSurvivesReload, signIn, tokenFromHash } from "../owner-session";
import { OwnerSessions } from "./OwnerSessions";
import { DataTable, type Column } from "./DataTable";
import { DetailPanel } from "./DetailPanel";
import { Time } from "./ui";

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };

const field = {
  display: "block",
  width: "100%",
  marginTop: "0.25rem",
  padding: "0.5rem",
  borderRadius: "4px",
  border: "1px solid var(--border)",
  background: "var(--bg-primary)",
  color: "var(--text-primary)",
};

const primaryButton = {
  padding: "0.5rem 1rem",
  borderRadius: "4px",
  border: "none",
  background: "var(--accent)",
  color: "white",
  cursor: "pointer",
  whiteSpace: "nowrap" as const,
};

const secondaryButton = {
  ...primaryButton,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-primary)",
};

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
  return (
    <div className="card" data-decision={decision.id}>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.25rem" }}>
        <span className={`badge ${KIND_BADGE[decision.kind] ?? "badge-neutral"}`}>{KIND_LABELS[decision.kind]}</span>
        <h3 style={{ margin: 0 }}>{decision.title}</h3>
      </div>
      <div style={muted}>
        {decision.project} · raised by <code>{decision.source.module}</code> ({decision.source.ref}) ·{" "}
        {time(decision.createdAt)}
        {decision.raisedVia === "http" && (
          <span data-raised-via="http"> · over HTTP, so that module name is only what the caller said</span>
        )}
      </div>
      {expiry && (
        <div style={{ ...muted, color: decision.overdue ? "var(--error)" : "var(--warning)" }}>{expiry}</div>
      )}

      <p style={{ whiteSpace: "pre-wrap", margin: "0.75rem 0" }}>{decision.context}</p>
      {/* Links are text to copy, never clickable: a decision's links come from whoever raised it */}
      {decision.links.length > 0 && (
        <ul style={{ ...muted, margin: "0 0 0.75rem 1rem" }} data-links="text">
          {decision.links.map((link) => (
            <li key={link.url}>
              {link.label}: <code>{link.url}</code>{" "}
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(link.url)}
                style={{ ...secondaryButton, padding: "0.1rem 0.4rem", fontSize: "0.75rem" }}
                title="Copy the address, then check it before you open it"
              >
                Copy
              </button>
            </li>
          ))}
        </ul>
      )}
      {decision.blocks.length > 0 && (
        <div style={muted}>
          Waiting on this:{" "}
          {decision.blocks.map((ref) => (
            <code key={ref} style={{ marginRight: "0.5rem" }}>
              {ref}
            </code>
          ))}
        </div>
      )}
      <div style={{ margin: "0.75rem 0" }}>
        <strong>Recommended: {recommended?.label ?? decision.recommended.optionId}.</strong>{" "}
        <span style={muted}>{decision.recommended.reasoning}</span>
      </div>

      {decision.kind === "credentials" && (
        <label style={{ display: "block", margin: "0.75rem 0" }}>
          <span style={muted}>
            Secret for <code>{decision.secretName}</code>. It goes to the secret store ({p.secretStore}) and is
            never shown again.
          </span>
          <input
            type="password"
            autoComplete="new-password"
            name={`secret-${decision.id}`}
            onChange={(e) => p.onSecret(e.target.value)}
            disabled={p.submitting}
            style={field}
          />
        </label>
      )}
      {/* No note on credentials decisions: a secret could end up in it */}
      {decision.kind !== "credentials" && (
        <textarea
          placeholder="Note (optional)"
          rows={2}
          onChange={(e) => p.onNote(e.target.value)}
          disabled={p.submitting}
          style={field}
        />
      )}

      {p.stage === "confirm" && p.pending ? (
        <div
          className="card"
          role="alertdialog"
          style={{ marginTop: "0.75rem", borderColor: "var(--warning)", background: "rgba(255, 152, 0, 0.1)" }}
        >
          <p style={{ margin: 0, fontWeight: "bold", color: "var(--warning)" }}>Confirm your answer</p>
          <p style={{ margin: "0.5rem 0" }}>{confirmationText(decision, p.pending)}</p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" onClick={p.onCancel} disabled={p.submitting} style={secondaryButton}>
              Cancel
            </button>
            <button type="button" onClick={p.onConfirm} disabled={p.submitting} style={primaryButton}>
              {p.submitting ? "Sending..." : `Confirm: ${p.pending.label}`}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.75rem" }}>
          {decision.options.map((option) => {
            const isRecommended = option.id === decision.recommended.optionId;
            const needsSecret = option.suppliesSecret === true && !p.hasSecret;
            const blockedBy = !p.canAnswer
              ? "Unlock answering first"
              : needsSecret
                ? "Enter the secret first"
                : undefined;
            return (
              <div key={option.id} style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}>
                <button
                  type="button"
                  onClick={() => p.onChoose(option)}
                  disabled={p.submitting || blockedBy !== undefined}
                  title={blockedBy}
                  style={isRecommended ? primaryButton : secondaryButton}
                >
                  {option.label}
                  {isRecommended ? " (recommended)" : ""}
                </button>
                <span style={muted}>
                  {option.consequences}
                  {decision.defaultOptionId === option.id ? " Applied if nobody answers before it expires." : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {p.error && (
        <div className="error" style={{ marginTop: "0.75rem" }}>
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
    <div style={{ marginTop: "0.5rem" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{ ...secondaryButton, padding: "0.25rem 0.5rem", fontSize: "0.8rem" }}
      >
        {open ? "Hide history" : "History"}
      </button>
      {open && error && <div className="error">{error}</div>}
      {open && entries && <AuditList entries={entries} />}
    </div>
  );
}

export function AuditList({ entries }: { entries: DecisionAuditEntry[] }) {
  return (
    <ul style={{ ...muted, margin: "0.5rem 0 0 1rem" }}>
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
    <div className="card" data-unlock="answering" style={{ borderColor: "var(--warning)" }}>
      <h3>Unlock answering</h3>
      <p style={muted}>
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
        placeholder="Owner token"
        onChange={(e) => {
          token.current = e.target.value;
        }}
        disabled={busy}
        style={field}
      />
      <button type="button" onClick={() => void unlock()} disabled={busy} style={{ ...primaryButton, marginTop: "0.5rem" }}>
        {busy ? "Unlocking..." : "Unlock answering"}
      </button>
      {error && (
        <div className="error" style={{ marginTop: "0.5rem" }}>
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
    render: (d) => <span className={`badge ${KIND_BADGE[d.kind] ?? "badge-neutral"}`}>{KIND_LABELS[d.kind]}</span>,
  },
  {
    key: "title",
    label: "Decision",
    sort: (d) => d.title,
    render: (d) => (
      <>
        {d.title}
        <div style={muted}>
          {d.project} · {d.source.module}
        </div>
      </>
    ),
  },
  { key: "raised", label: "Raised", sort: (d) => d.createdAt, render: (d) => <Time iso={d.createdAt} /> },
  {
    key: "status",
    label: "Status",
    sort: (d) => (d.status === "open" ? (d.overdue ? 0 : 1) : 2),
    render: (d) =>
      d.status === "open" ? (
        <span className={`badge ${d.overdue ? "badge-error" : "badge-warning"}`}>{d.overdue ? "overdue" : "open"}</span>
      ) : (
        <span style={muted}>{outcomeText(d)}</span>
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
          <span className={`badge ${KIND_BADGE[decision.kind] ?? "badge-neutral"}`}>{KIND_LABELS[decision.kind]}</span>{" "}
          <span style={muted}>
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
          <div style={muted}>
            {decision.project} · raised by <code>{decision.source.module}</code> ({decision.source.ref})
          </div>
          <p style={{ whiteSpace: "pre-wrap", margin: "0.75rem 0" }}>{decision.context}</p>
          <ul style={{ ...muted, margin: "0 0 0.75rem 1rem" }}>
            {decision.options.map((o) => (
              <li key={o.id}>
                <strong>{o.label}</strong>: {o.consequences}
              </li>
            ))}
          </ul>
          <p>
            <strong>Outcome:</strong> {outcomeText(decision)}
            {decision.closedAt && (
              <span style={muted}>
                {" "}
                (<Time iso={decision.closedAt} now={now} />)
              </span>
            )}
          </p>
          {decision.answer?.note && <p style={muted}>Note: {decision.answer.note}</p>}
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
  const open = decisions.filter((d) => d.status === "open");
  const closed = decisions.filter((d) => d.status !== "open").slice(0, 50);
  const shown = [...open, ...closed];
  const current = selected ? (decisions.find((d) => d.id === selected) ?? null) : null;
  return (
    <div>
      <p style={{ ...muted, marginBottom: "1rem" }}>
        Decisions ({open.length} open): only what Lair can&apos;t decide for you: pricing, legal, spend, accounts, credentials,
        go/no-go, and problems its playbooks couldn&apos;t fix. Every project&apos;s are here.
      </p>

      {answering ? <OwnerSessions onSignedOut={onSignedOut} /> : <UnlockAnswering onUnlock={onUnlock} />}

      {open.length === 0 && (
        <div className="card">
          <p style={muted}>Nothing needs you right now.</p>
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
          empty={<p style={muted}>No decisions yet: modules raise them here when they need you.</p>}
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
          <p style={muted}>
            No decision <code>{selected}</code> in the latest {decisions.length}: it may be older, or the link may be wrong.
          </p>
        </DetailPanel>
      )}
    </div>
  );
}

/** The open count in the nav ("needs you"); red while any decision is overdue. */
export function DecisionCountBadge({ open, overdue }: DecisionCounts) {
  if (open <= 0) return null;
  return (
    <span
      className={`badge ${overdue > 0 ? "badge-error" : "badge-warning"}`}
      style={{ marginLeft: "0.4rem" }}
      title={`${open} decision(s) need you${overdue > 0 ? `, ${overdue} overdue` : ""}`}
    >
      {open}
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
        if (!cancelled) setCounts({ open: s.open, overdue: s.overdue });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return counts ? <DecisionCountBadge open={counts.open} overdue={counts.overdue} /> : null;
}
