/**
 * An agent's detail (#/work/<agent>): its task and description, the current
 * run (state, model, started, recoveries, claims), what it waits for, the
 * holds fill keeps for the owner (Release), its tasks_file lines, budget,
 * recent runs and recoveries, its recent reports, and the tail of its log.
 * The log and every action are the owner's.
 */
import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { agentDetail, type FillItem } from "../work-view";
import {
  failureMessage,
  freshSessionAction,
  postJson,
  releaseClaimAction,
  releaseFillHoldAction,
  runConfirmed,
  type ConfirmableAction,
} from "../agents-actions";
import { canStartDragon } from "../dragon-start";
import { startDragon, stopDragon } from "../owner-actions";
import type { Dragon, DragonManagementConfig, DragonStartRequest, DragonStopRequest, QueueLine } from "../../shared/types";
import type { AgentRunView, AgentsStatusView } from "../../shared/agents-types";
import type { AgentLogView } from "../../shared/dashboard-types";
import { DetailPanel, DetailSection } from "./DetailPanel";
import { DragonStartDialog } from "./DragonStartDialog";
import { DragonStopDialog } from "./DragonStopDialog";
import { BudgetLines } from "./Budget";
import { EmptyState, ErrorState, KeyValues, Loading, OwnerOnlyNotice, Time, useOwnerSignedIn } from "./ui";
import { Badge } from "../ui/Badge";
import { Button, ButtonLink } from "../ui/Button";
import { CodeBlock } from "../ui/CodeBlock";

interface Props {
  id: string;
  project: string;
  refreshKey: number;
  dragons: readonly Dragon[];
  status: AgentsStatusView | null;
  readOnly: boolean;
  dragonConfig: DragonManagementConfig | null;
  onChanged: () => void;
  onClose: () => void;
}

/** How many log lines the panel asks for (the server caps it) */
const LOG_LINES = 200;

interface Fetched<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** What AgentDetail reads, handed to the view: this browser's owner status, the runs, reports and log. */
export interface AgentDetailData {
  signedIn: boolean | null;
  runs: Fetched<AgentRunView[]>;
  queue: Fetched<QueueLine[]>;
  /** Fetched only once this browser is signed in as the owner */
  log: Fetched<AgentLogView>;
}

export function AgentDetail(props: Props) {
  const { id, project, refreshKey, status } = props;
  const signedIn = useOwnerSignedIn(refreshKey);
  const runs = useApi<AgentRunView[]>("/agents/runs?limit=200", project, refreshKey, { skip: status === null });
  const queue = useApi<QueueLine[]>(`/dragons/${encodeURIComponent(id)}/queue`, project, refreshKey);
  // The log is the owner's: not even asked for before this browser is signed in as the owner
  const log = useApi<AgentLogView>(`/dashboard/agents/${encodeURIComponent(id)}/log?lines=${LOG_LINES}`, project, refreshKey, {
    owner: true,
    skip: signedIn !== true,
  });
  return <AgentDetailView {...props} data={{ signedIn, runs, queue, log }} />;
}

export function AgentDetailView({
  id,
  project,
  dragons,
  status,
  readOnly,
  dragonConfig,
  onChanged,
  onClose,
  data,
}: Props & { data: AgentDetailData }) {
  const { signedIn, runs, queue, log } = data;
  const managed = status !== null;
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  const model = agentDetail(id, dragons, status, runs.data ?? [], queue.data ?? []);
  if (!model) {
    return (
      <DetailPanel title={id} onClose={onClose}>
        {dragons.length === 0 && !status ? (
          <Loading what={`agent ${id}`} />
        ) : (
          <EmptyState title={`No agent ${id} in ${project}`}>
            It is not in dragons.txt, the YAML dragons: or the agents module. The link may be for another project.
          </EmptyState>
        )}
      </DetailPanel>
    );
  }

  const owner = signedIn === true && !readOnly;
  const act = async (action: ConfirmableAction) => {
    const result = await runConfirmed(action, (q) => window.confirm(q), postJson);
    if (!result.sent) return;
    setMessage(result.ok ? { ok: true, text: "Done: the next check carries it out." } : { ok: false, text: failureMessage(result) });
    onChanged();
  };
  const releaseHold = (item: FillItem) => {
    if (item.task) void act(releaseFillHoldAction(project, item.task, id));
  };

  const dragon = dragons.find((d) => d.id === id) ?? null;
  const startable = !model.managed && canStartDragon(id, dragonConfig?.dragons);
  const handleStart = async (request: DragonStartRequest) => {
    const data = await startDragon(project, request);
    if (!data.success) throw new Error(data.error || "Failed to start the agent");
    if (data.data?.exitCode !== 0) throw new Error(data.data?.stderr || "The start command failed");
    onChanged();
  };
  const handleStop = async (request: DragonStopRequest) => {
    const data = await stopDragon(project, request);
    if (!data.success) throw new Error(data.error || "Failed to stop the agent");
    if (data.data?.exitCode !== 0) throw new Error(data.data?.stderr || "The stop command failed");
    onChanged();
  };

  const run = model.run;
  return (
    <DetailPanel
      title={
        <>
          {model.name} <span className="muted small">({id})</span>
        </>
      }
      subtitle={
        <>
          <Badge tone={model.badge}>{model.state}</Badge>{" "}
          {model.stateDetail && <span className="muted small">{model.stateDetail}</span>}
          {!model.managed && <span className="muted small"> · run by the project&apos;s own launcher</span>}
        </>
      }
      onClose={onClose}
    >
      {message && (
        <div className={message.ok ? "card muted small" : "error"} role="status">
          {message.text}
        </div>
      )}
      {!readOnly && signedIn === false && <OwnerOnlyNotice text="Starting, stopping and releasing are the owner's." />}

      <DetailSection title="Task">
        {model.task ? (
          <p>
            <code>{model.task}</code>
          </p>
        ) : (
          <p className="muted small">No task right now.</p>
        )}
        {model.description && <p>{model.description}</p>}
        {model.instructions && <p className="muted small italic">Standing instructions: {model.instructions}</p>}
        <KeyValues
          rows={[
            ["Adapter", model.adapter],
            ["Model", model.model],
            ["Profiles", model.profiles],
            ["Machine", model.machine],
            ["Last log", model.lastLogTime ? <Time iso={model.lastLogTime} /> : null],
          ]}
        />
        {!readOnly && !model.managed && (
          <div className="button-row">
            {startable && !dragon?.running && (
              <Button size="sm" disabled={signedIn !== true} onClick={() => setStarting(true)}>
                Start
              </Button>
            )}
            {dragon?.running && (
              <Button size="sm" variant="danger" disabled={signedIn !== true} onClick={() => setStopping(true)}>
                Stop
              </Button>
            )}
          </div>
        )}
      </DetailSection>

      {managed && (
        <DetailSection
          title="Current run"
          actions={
            owner && run?.active ? (
              <Button size="sm" onClick={() => void act(freshSessionAction(project, run.id, id, run.task))}>
                Fresh session
              </Button>
            ) : undefined
          }
        >
          {run ? (
            <>
              {model.waiting && <p className="waiting">{model.waiting}</p>}
              <KeyValues
                rows={[
                  ["State", <span key="s" className={`badge ${run.badge}`}>{run.state}</span>],
                  ["Task", <code key="t">{run.task}</code>],
                  ["Model", `${run.adapter}${run.model ? ` / ${run.model}` : ""}`],
                  ["Started", run.startedAt ? <Time iso={run.startedAt} /> : <span className="muted small">not yet (asked <Time iso={run.requestedAt} />)</span>],
                  ["Ended", run.endedAt ? <Time iso={run.endedAt} /> : null],
                  ["Attempt", String(run.attempt)],
                  ["Session", run.session],
                  ["Recoveries", run.recoveries],
                  ["Process", run.pid === null ? null : `pid ${run.pid}`],
                  ["Exit code", run.exitCode === null ? null : String(run.exitCode)],
                  ["Last error", run.lastError],
                  ["Detail", run.detail],
                ]}
              />
            </>
          ) : (
            <p className="muted small">The agents module has not run it yet.</p>
          )}
          <h4>Claims</h4>
          {model.claims.length === 0 ? (
            <p className="muted small">None.</p>
          ) : (
            <ul className="plain-list">
              {model.claims.map((claim) => (
                <li key={claim.task}>
                  <code>{claim.task}</code> by run {claim.runId.slice(0, 8)}, owner pid {claim.ownerPid}
                  {claim.ownerAlive === null ? "" : claim.ownerAlive ? " (alive)" : " (dead)"}, since <Time iso={claim.claimedAt} />{" "}
                  {owner && (
                    <Button size="sm" onClick={() => void act(releaseClaimAction(project, claim.task, id))}>
                      Release
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </DetailSection>
      )}

      {model.holds.length > 0 && (
        <DetailSection title="Holds">
          <ul className="plain-list">
            {model.holds.map((hold) => (
              <li key={hold.line}>
                <Badge tone={hold.badge}>{hold.state}</Badge> <code>{hold.task ?? `line ${hold.line}`}</code>{" "}
                <span className="muted small">{hold.detail}</span>{" "}
                {hold.waiting && <span className="waiting">{hold.waiting} </span>}
                {hold.decisionHref && (
                  <>
                    <ButtonLink size="sm" href={hold.decisionHref} data-hold-decision="answer">
                      Answer it
                    </ButtonLink>{" "}
                  </>
                )}
                {hold.releasable && owner && (
                  <Button
                    size="sm"
                    onClick={() => releaseHold(hold)}
                    title={hold.hold === "paused" ? "Fill starts it again on its next check" : undefined}
                  >
                    {hold.hold === "paused" ? "Release (start it again)" : "Release"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      {model.fill.length > 0 && (
        <DetailSection title="Tasks file">
          <table className="table">
            <tbody>
              {model.fill.map((item) => (
                <tr key={item.line}>
                  <td className="muted small">line {item.line}</td>
                  <td>
                    {item.task ? <code>{item.task}</code> : "—"}
                    {item.description && <div className="muted small">{item.description}</div>}
                  </td>
                  <td>
                    <Badge tone={item.badge}>{item.state}</Badge>
                    <div className="muted small">{item.detail}</div>
                    {item.waiting && <div className="waiting">{item.waiting}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DetailSection>
      )}

      {model.budget && (
        <DetailSection title="Budget">
          <BudgetLines budget={model.budget} />
        </DetailSection>
      )}

      {managed && (
        <DetailSection title="Recent runs">
          {runs.error && <ErrorState what="its runs" error={runs.error} />}
          {model.recentRuns.length === 0 ? (
            <p className="muted small">{runs.loading ? "Loading…" : "No runs yet."}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Asked</th>
                  <th>Task</th>
                  <th>State</th>
                  <th>Model</th>
                </tr>
              </thead>
              <tbody>
                {model.recentRuns.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Time iso={r.requestedAt} />
                    </td>
                    <td>
                      <code>{r.task}</code>
                    </td>
                    <td>
                      <Badge tone={r.badge}>{r.state}</Badge>
                      {r.exitCode !== null && <span className="muted small"> exit {r.exitCode}</span>}
                    </td>
                    <td className="muted small">{r.model ?? r.adapter}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DetailSection>
      )}

      {model.recoveries.length > 0 && (
        <DetailSection title="Recoveries">
          <ul className="plain-list">
            {model.recoveries.map((e) => (
              <li key={e.id} title={e.evidence.join("\n")}>
                <Time iso={e.at} /> <code>{e.kind}</code> {e.summary}
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      {model.stats && (
        <DetailSection title="Last 7 days">
          <KeyValues
            rows={[
              ["Done", String(model.stats.doneCount)],
              ["Blocked", String(model.stats.blockedCount)],
              ["Gates", `${model.stats.gatesSubmitted} submitted, ${model.stats.gatesPassed} passed`],
              ["First-time pass rate", model.stats.gatesSubmitted ? `${model.stats.firstTimePassRate}%` : null],
              ["Early stops", String(model.stats.earlyStops)],
            ]}
          />
        </DetailSection>
      )}

      <DetailSection title="Recent reports">
        {model.reports.length === 0 ? (
          <p className="muted small">{queue.loading ? "Loading…" : "No reports in the queue file."}</p>
        ) : (
          <ul className="plain-list">
            {model.reports.map((line, i) => (
              <li key={`${line.timestamp ?? ""}-${i}`}>
                <span className={`badge ${line.type === "DONE" ? "badge-success" : line.type === "BLOCKED" ? "badge-error" : line.type === "WAITING" ? "badge-warning" : "badge-neutral"}`}>
                  {line.type}
                </span>{" "}
                {line.timestamp && <span className="muted small">{line.timestamp} </span>}
                {line.task ?? line.message}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection title="Log">
        {signedIn !== true ? (
          <OwnerOnlyNotice text="An agent's log can hold anything it printed, so it is shown to the owner only." />
        ) : log.error ? (
          <ErrorState what="the log" error={log.error} />
        ) : !log.data ? (
          <Loading what="the log" />
        ) : !log.data.log ? (
          <p className="muted small">No log yet: Lair looks for {id}.log or {id}-&lt;UTC time&gt;.log in the project&apos;s agents_dir.</p>
        ) : (
          <>
            <p className="muted small">
              {log.data.log.file}, written <Time iso={log.data.log.modifiedAt} />
              {log.data.source === "run" ? " (the agents module's run)" : ""}
              {log.data.log.truncated ? `; the last ${log.data.log.lines.length} lines` : ""}
            </p>
            <CodeBlock label="Run log">{log.data.log.lines.join("\n")}</CodeBlock>
          </>
        )}
      </DetailSection>

      {starting && dragonConfig && (
        <DragonStartDialog
          dragons={dragonConfig.dragons ?? {}}
          availableModels={dragonConfig.available_models || []}
          defaultInstructions={dragonConfig.default_instructions}
          selectedDragonId={id}
          onStart={handleStart}
          onClose={() => setStarting(false)}
        />
      )}
      {stopping && dragon && <DragonStopDialog dragon={dragon} onStop={handleStop} onClose={() => setStopping(false)} />}
    </DetailPanel>
  );
}
