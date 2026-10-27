/**
 * Delivery view - the project's environments (docker compose projects):
 * each service's state, health, restart count, hold, crash loop and last
 * error lines, Up / Down / Restart for the environment and for each service,
 * and the recent operations. Down, Restart and Deploy ask first; Down asks
 * for a reason, because it holds what it stops (Lair won't start a held
 * service until you release it). Configured in the project YAML
 * (delivery:, see docs/configuration.md#delivery).
 */
import { useState } from "react";
import { useApi } from "../hooks/useApi";
import type {
  DeliveryProjectStatus,
  EnvironmentStatus,
  Operation,
  OperationStatus,
  ServiceState,
  ServiceStatus,
} from "../../shared/delivery-types";
import { needsConfirmation, needsReason, runDeliveryAction, type DeliveryAction } from "../delivery-api";
import { SignInHint } from "./SignInHint";

interface Props {
  project: string;
  refreshKey: number;
}

interface Pending {
  environment: string;
  service?: string;
  action: DeliveryAction;
}

const STATE_BADGE: Record<ServiceState, string> = {
  running: "badge-success",
  stopped: "badge-neutral",
  unhealthy: "badge-error",
  restarting: "badge-warning",
  unknown: "badge-neutral",
};

const OPERATION_BADGE: Record<OperationStatus, string> = {
  running: "badge-warning",
  succeeded: "badge-success",
  failed: "badge-error",
  rolled_back: "badge-warning",
  interrupted: "badge-warning",
};

const ACTION_LABEL: Record<DeliveryAction, string> = {
  up: "Up",
  down: "Down",
  restart: "Restart",
  deploy: "Deploy",
  release: "Release",
};

const ACTION_COLOR: Record<DeliveryAction, string> = {
  up: "var(--success)",
  down: "var(--error)",
  restart: "var(--warning)",
  deploy: "var(--accent, var(--warning))",
  release: "var(--text-secondary)",
};

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };

function time(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function targetLabel(p: Pending): string {
  return p.service ? `${p.service} (${p.environment})` : `environment ${p.environment}`;
}

function warning(p: Pending): string {
  switch (p.action) {
    case "down":
      return p.service
        ? `Stops ${p.service} and holds it: Lair won't start it (not on Up, not on a deploy, not from the watchdog) until you release it.`
        : `Stops every configured service of ${p.environment} and holds them until the next environment Up. Services of the compose project that Lair doesn't manage are left alone.`;
    case "restart":
      return p.service
        ? `Restarts ${p.service} and waits for it to be healthy. A crash loop mark on it is cleared.`
        : `Restarts every service in start order, each healthy before the next. Held and crash-looping services are skipped.`;
    case "deploy":
      return `Tags the image ${p.service ?? "each service"} runs, rebuilds and rolls it, and rolls back if it isn't healthy in time.`;
    default:
      return "";
  }
}

function ActionButton({
  action,
  disabled,
  onClick,
}: {
  action: DeliveryAction;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "0.25rem 0.5rem",
        borderRadius: "4px",
        border: `1px solid ${ACTION_COLOR[action]}`,
        background: "transparent",
        color: ACTION_COLOR[action],
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: "0.85rem",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {ACTION_LABEL[action]}
    </button>
  );
}

function ConfirmDialog({
  pending,
  onConfirm,
  onClose,
  error,
}: {
  pending: Pending;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
  error: string | null;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const reasonMissing = needsReason(pending.action) && reason.trim() === "";

  const confirm = async () => {
    setSubmitting(true);
    await onConfirm(reason.trim());
    setSubmitting(false);
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="detail-panel" style={{ maxWidth: "450px" }}>
        <div className="detail-panel-header">
          <h2>
            {ACTION_LABEL[pending.action]} {targetLabel(pending)}?
          </h2>
          <button className="detail-panel-close" onClick={onClose}>
            ×
          </button>
        </div>
        <p style={{ ...muted, marginBottom: "1rem" }}>{warning(pending)}</p>
        {needsReason(pending.action) && (
          <label style={{ display: "block", marginBottom: "1rem" }}>
            <span style={muted}>Reason (shown on the hold)</span>
            <input
              type="text"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. debugging the database by hand"
              style={{ display: "block", width: "100%", marginTop: "0.25rem", padding: "0.4rem" }}
            />
          </label>
        )}
        {error && (
          <p className="error" style={{ marginBottom: "1rem" }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <ActionButton
            action={pending.action}
            disabled={submitting || reasonMissing}
            onClick={() => void confirm()}
          />
        </div>
      </div>
    </>
  );
}

function ServiceRow({
  service,
  busy,
  unreadable,
  readOnly,
  onAction,
}: {
  service: ServiceStatus;
  busy: boolean;
  /** The environment can't be read, or wasn't yet: Up, Restart and Deploy wait */
  unreadable: boolean;
  readOnly: boolean;
  onAction: (action: DeliveryAction) => void;
}) {
  const held = service.held !== null;
  const locked = busy || readOnly || unreadable;
  return (
    <tr>
      <td>
        <code>{service.name}</code>
      </td>
      <td>
        <span className={`badge ${STATE_BADGE[service.state]}`}>{service.state}</span>
        {held && (
          <span className="badge badge-neutral" style={{ marginLeft: "0.25rem" }}>
            held
          </span>
        )}
        {service.crashLoop && (
          <span className="badge badge-error" style={{ marginLeft: "0.25rem" }}>
            crash loop
          </span>
        )}
        {service.behind && (
          <span className="badge badge-warning" style={{ marginLeft: "0.25rem" }}>
            behind
          </span>
        )}
      </td>
      <td style={muted}>
        {service.healthDetail}
        {service.held && (
          <div>
            Held ({service.held.source}) {time(service.held.heldAt)}: {service.held.reason}
          </div>
        )}
        {service.crashLoop && (
          <div>
            {service.crashLoop.restarts} restarts in {service.crashLoop.windowMinutes} min since{" "}
            {time(service.crashLoop.since)}: Lair stopped restarting it
          </div>
        )}
        {service.behind && (
          <div>
            Not deployed at the latest merge
            {service.deployedSha ? ` (runs ${service.deployedSha.slice(0, 12)})` : ""}: the next automatic deploy
            includes it
          </div>
        )}
        {service.lastErrorLines.length > 0 && (
          <pre className="code" style={{ marginTop: "0.5rem", maxHeight: "160px", padding: "0.5rem" }}>
            {service.lastErrorLines.join("\n")}
          </pre>
        )}
      </td>
      <td>{service.restartCount}</td>
      <td>
        <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
          {held ? (
            <ActionButton action="release" disabled={readOnly} onClick={() => onAction("release")} />
          ) : (
            <ActionButton action="up" disabled={locked} onClick={() => onAction("up")} />
          )}
          <ActionButton
            action="restart"
            disabled={locked || held || service.containers.length === 0}
            onClick={() => onAction("restart")}
          />
          {/* Down works during another operation and without a read: it holds, then stops what it can */}
          <ActionButton action="down" disabled={readOnly} onClick={() => onAction("down")} />
          {service.buildable && (
            <ActionButton action="deploy" disabled={locked || held} onClick={() => onAction("deploy")} />
          )}
        </div>
      </td>
    </tr>
  );
}

function EnvironmentCard({
  env,
  readOnly,
  onAction,
}: {
  env: EnvironmentStatus;
  readOnly: boolean;
  onAction: (p: Pending) => void;
}) {
  const busy = env.operation !== null;
  const unreadable = env.error !== null || env.checkedAt === null;
  const locked = busy || readOnly || unreadable;
  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>{env.environment}</h3>
        <code style={muted}>{env.composeProject}</code>
        <span style={muted}>Checked: {time(env.checkedAt)}</span>
        <div style={{ display: "flex", gap: "0.25rem", marginLeft: "auto" }}>
          {(["up", "restart", "down"] as const).map((action) => (
            <ActionButton
              key={action}
              action={action}
              disabled={action === "down" ? readOnly : locked}
              onClick={() => onAction({ environment: env.environment, action })}
            />
          ))}
        </div>
      </div>
      {env.error && (
        <div className="error" style={{ marginTop: "0.75rem" }}>
          Can't read the environment, so its state is unknown and Up, Restart and Deploy wait: {env.error}
        </div>
      )}
      {!env.error && env.checkedAt === null && (
        <p style={{ ...muted, marginTop: "0.75rem" }}>Not read yet: Lair reads it every interval_seconds.</p>
      )}
      {env.operation && (
        <p style={{ ...muted, marginTop: "0.75rem" }}>
          Running: {env.operation.kind}
          {env.operation.services.length > 0 ? ` ${env.operation.services.join(", ")}` : ""} since{" "}
          {time(env.operation.startedAt)}
        </p>
      )}
      {env.autoDeploy.enabled && (
        <p style={{ ...muted, marginTop: "0.5rem" }}>
          Deploys after merges to <code>{env.autoDeploy.ref}</code>
          {env.autoDeploy.lastSha ? ` (last seen ${env.autoDeploy.lastSha.slice(0, 12)})` : ""}
          {env.autoDeploy.blocked ? `; not acting: ${env.autoDeploy.blocked}` : ""}
        </p>
      )}
      <table className="table" style={{ marginTop: "0.75rem" }}>
        <thead>
          <tr>
            <th>Service</th>
            <th>State</th>
            <th>Health and errors</th>
            <th>Restarts</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {env.services.map((service) => (
            <ServiceRow
              key={service.name}
              service={service}
              busy={busy}
              unreadable={unreadable}
              readOnly={readOnly}
              onAction={(action) => onAction({ environment: env.environment, service: service.name, action })}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function stepLine(op: Operation): string {
  const last = [...op.steps].reverse().find((s) => s.status !== "succeeded") ?? op.steps[op.steps.length - 1];
  if (!last) return "";
  const what = last.argv ? last.argv.join(" ") : (last.detail ?? "");
  return `${last.action}${last.service ? ` ${last.service}` : ""}: ${what}`;
}

export function Delivery({ project, refreshKey }: Props) {
  const [bump, setBump] = useState(0);
  const key = refreshKey + bump;
  const status = useApi<DeliveryProjectStatus>("/delivery/status", project, key);
  const operations = useApi<Operation[]>("/delivery/operations", project, key);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const send = async (p: Pending, reason?: string) => {
    setError(null);
    try {
      const op = await runDeliveryAction(
        { project, environment: p.environment, service: p.service },
        p.action,
        { confirmed: needsConfirmation(p.action), reason },
      );
      setNotice(`${ACTION_LABEL[p.action]} ${targetLabel(p)}: ${op.status === "running" ? "started" : op.status}`);
      setPending(null);
      setBump((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onAction = (p: Pending) => {
    if (needsConfirmation(p.action)) {
      setError(null);
      setPending(p);
    } else {
      void send(p);
    }
  };

  if (status.loading && !status.data) return <div className="loading">Loading delivery...</div>;
  if (status.error && !status.data) return <div className="error">Error: {status.error}</div>;
  const s = status.data;
  if (!s) return null;

  if (!s.enabled) {
    return (
      <div>
        <h2 style={{ marginBottom: "1.5rem" }}>Delivery</h2>
        <div className="card">
          <p>
            Delivery is off for this project. Add a <code>delivery:</code> block with an environment (a docker
            compose project) and <code>enabled: true</code> to its YAML.
          </p>
          {s.errors.map((e) => (
            <p key={e} className="error" style={{ marginTop: "1rem" }}>
              {e}
            </p>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
        <h2>Delivery</h2>
        {s.readOnly && <span className="badge badge-neutral">Read-only: no actions</span>}
      </div>
      {!s.readOnly && <SignInHint what="Bringing services up and down, deploying and releasing" refreshKey={refreshKey} />}
      {s.lastError && <div className="error">Last check failed: {s.lastError}</div>}
      {error && !pending && <div className="error">{error}</div>}
      {notice && <p style={{ ...muted, marginBottom: "1rem" }}>{notice}</p>}

      {s.environments.map((env) => (
        <EnvironmentCard key={env.environment} env={env} readOnly={s.readOnly} onAction={onAction} />
      ))}

      <div className="card">
        <h3>Operations</h3>
        {(operations.data ?? []).length === 0 ? (
          <p style={muted}>None</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Operation</th>
                <th>Status</th>
                <th>Last step</th>
              </tr>
            </thead>
            <tbody>
              {(operations.data ?? []).slice(0, 20).map((op) => (
                <tr key={op.id}>
                  <td style={muted}>{time(op.startedAt)}</td>
                  <td>
                    <code>
                      {op.environment} {op.kind}
                      {op.services.length > 0 ? ` ${op.services.join(", ")}` : ""}
                    </code>
                    <span style={muted}> by {op.requestedBy}</span>
                    {op.sha && <span style={muted}> @ {op.sha.slice(0, 12)}</span>}
                  </td>
                  <td>
                    <span className={`badge ${OPERATION_BADGE[op.status]}`}>{op.status}</span>
                    {op.error && <div style={muted}>{op.error}</div>}
                  </td>
                  <td>
                    <code style={{ fontSize: "0.8rem" }}>{stepLine(op)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pending && (
        <ConfirmDialog
          pending={pending}
          error={error}
          onClose={() => {
            setPending(null);
            setError(null);
          }}
          onConfirm={(reason) => send(pending, reason || undefined)}
        />
      )}
    </div>
  );
}
