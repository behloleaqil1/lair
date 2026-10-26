/**
 * Decision Inbox view: the questions only a human can answer (pricing,
 * legal, spend, accounts, credentials, go/no-go, escalations), from every
 * project, open first by urgency. Each one shows what it blocks and why, its
 * options with their consequences, and the recommended one.
 *
 * Spend and go/no-go answers go through a confirmation step. A credentials
 * decision has a password field: the value goes to the server's secret
 * store with the answer and is never shown again (the API has none to give).
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
  listDecisions,
  needsConfirmation,
  outcomeText,
  postAnswer,
  type DecisionSummary,
} from "../decisions-api";

interface Props {
  project: string;
  refreshKey: number;
}

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
      </div>
      {expiry && (
        <div style={{ ...muted, color: decision.overdue ? "var(--error)" : "var(--warning)" }}>{expiry}</div>
      )}

      <p style={{ whiteSpace: "pre-wrap", margin: "0.75rem 0" }}>{decision.context}</p>
      {decision.links.length > 0 && (
        <ul style={{ ...muted, margin: "0 0 0.75rem 1rem" }}>
          {decision.links.map((link) => (
            <li key={link.url}>
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                {link.label}
              </a>
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
      <textarea
        placeholder="Note (optional)"
        rows={2}
        onChange={(e) => p.onNote(e.target.value)}
        disabled={p.submitting}
        style={field}
      />

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
            return (
              <div key={option.id} style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}>
                <button
                  type="button"
                  onClick={() => p.onChoose(option)}
                  disabled={p.submitting || needsSecret}
                  title={needsSecret ? "Enter the secret first" : undefined}
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
  onAnswered,
}: {
  decision: Decision;
  now: number;
  secretStore: string;
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

export function DecisionInboxView({
  decisions,
  secretStore,
  now,
  onAnswered,
}: {
  decisions: Decision[];
  secretStore: string;
  now: number;
  onAnswered: () => void;
}) {
  const open = decisions.filter((d) => d.status === "open");
  const closed = decisions.filter((d) => d.status !== "open").slice(0, 25);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "1rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
        <h2>Decisions ({open.length} open)</h2>
        <span style={muted}>
          Only what Lair can't decide for you: pricing, legal, spend, accounts, credentials, go/no-go, and problems its
          playbooks couldn't fix.
        </span>
      </div>

      {open.length === 0 ? (
        <div className="card">
          <p style={muted}>Nothing needs you right now.</p>
        </div>
      ) : (
        open.map((decision) => (
          <DecisionCard
            key={decision.id}
            decision={decision}
            now={now}
            secretStore={secretStore}
            onAnswered={onAnswered}
          />
        ))
      )}

      <div className="card">
        <h3>Decided</h3>
        {closed.length === 0 ? (
          <p style={muted}>None yet</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Closed</th>
                <th>Project</th>
                <th>Kind</th>
                <th>Decision</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((d) => (
                <tr key={d.id}>
                  <td style={muted}>{time(d.closedAt)}</td>
                  <td>{d.project}</td>
                  <td>
                    <span className={`badge ${KIND_BADGE[d.kind] ?? "badge-neutral"}`}>{KIND_LABELS[d.kind]}</span>
                  </td>
                  <td>
                    {d.title}
                    {d.answer?.note && <div style={muted}>Note: {d.answer.note}</div>}
                  </td>
                  <td>{outcomeText(d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function DecisionInbox({ refreshKey }: Props) {
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [summary, setSummary] = useState<DecisionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listDecisions(), decisionSummary()])
      .then(([list, counts]) => {
        if (cancelled) return;
        setDecisions(list);
        setSummary(counts);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Network error");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, reload]);

  if (!decisions && error) return <div className="error">Error: {error}</div>;
  if (!decisions) return <div className="loading">Loading decisions...</div>;
  return (
    <>
      {error && <div className="error">Refresh failed: {error}</div>}
      <DecisionInboxView
        decisions={decisions}
        secretStore={summary?.secretStore ?? "the server's secret store"}
        now={Date.now()}
        onAnswered={() => setReload((n) => n + 1)}
      />
    </>
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

export function DecisionsBadge({ refreshKey }: { refreshKey: number }) {
  const [counts, setCounts] = useState<DecisionCounts | null>(null);
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
