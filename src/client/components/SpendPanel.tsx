/**
 * AI spend (docs/design/ai-spend.md §4.4): Home's panel and an agent's Spend line. Both read the owner-only
 * GET /api/agents/spend and show only while agents.spend.enabled is on (the agents status says so). The panel: a
 * today / 7 days switch, one stacked bar per unit (productive, idle, no result), the waste share, the top waste
 * reasons and the tasks with the most attempts without a completion, a table by agent, task, origin or project,
 * reloads and Lair-restart losses, and one line per guard. Tokens and cost say "not reported" where no adapter
 * reported them. View logic in spend-view.ts.
 */
import { useId, useState, type ReactNode } from "react";
import { useApi } from "../hooks/useApi";
import {
  CLASS_HINT,
  CLASS_LABEL,
  MODE_TONE,
  NOT_REPORTED,
  SPEND_PANEL_WINDOWS,
  SPEND_TABLE_GROUPS,
  WINDOW_PHRASE,
  agentSpendLine,
  groupRows,
  guardLines,
  lossesSentence,
  spendBars,
  spendEndpoint,
  topTaskRows,
  topWasteReasons,
  wasteSentence,
  type SpendBar,
  type SpendPanelWindow,
  type SpendSegmentClass,
  type SpendTableBy,
} from "../spend-view";
import type { SpendReportView } from "../../shared/agents-types";
import { linkTo } from "../router";
import { Badge, EmptyState, ErrorState, Loading, OwnerOnlyNotice } from "./ui";
import { Card } from "../ui/Card";
import { Select } from "../ui/Select";

export interface SpendFetch {
  data: SpendReportView | null;
  loading: boolean;
  error: string | null;
}

const OWNER_ONLY = "AI spend is cost and usage, so it is shown to the owner only.";

/** Home's panel: nothing at all while spend is off */
export function SpendPanel({ project, refreshKey, enabled, signedIn }: { project: string; refreshKey: number; enabled: boolean; signedIn: boolean | null }) {
  const [range, setRange] = useState<SpendPanelWindow>("today");
  const [by, setBy] = useState<SpendTableBy>("agent");
  const report = useApi<SpendReportView>(spendEndpoint(range, by), project, refreshKey, { owner: true, skip: !enabled || signedIn !== true });
  if (!enabled) return null;
  return <SpendPanelView report={report} signedIn={signedIn} range={range} by={by} onRange={setRange} onBy={setBy} />;
}

export interface SpendPanelViewProps {
  report: SpendFetch;
  signedIn: boolean | null;
  range: SpendPanelWindow;
  by: SpendTableBy;
  onRange: (range: SpendPanelWindow) => void;
  onBy: (by: SpendTableBy) => void;
}

/** The panel, stateless: SpendPanel holds the window, the grouping and the request */
export function SpendPanelView({ report, signedIn, range, by, onRange, onBy }: SpendPanelViewProps) {
  const switcher = (
    <div className="segmented" role="group" aria-label="AI spend window">
      {SPEND_PANEL_WINDOWS.map((w) => (
        <button key={w.id} type="button" className="mode-button" aria-pressed={range === w.id} data-spend-window={w.id} onClick={() => onRange(w.id)}>
          {w.label}
        </button>
      ))}
    </div>
  );
  let body: ReactNode;
  if (signedIn !== true) body = <OwnerOnlyNotice text={OWNER_ONLY} />;
  else if (report.error && !report.data) body = <ErrorState what="AI spend" error={report.error} />;
  else if (!report.data) body = <Loading what="AI spend" />;
  else body = <SpendReportBody report={report.data} range={range} by={by} onBy={onBy} />;
  return (
    <Card title="AI spend" actions={signedIn === true ? switcher : undefined} data-card="ai-spend">
      {body}
    </Card>
  );
}

function SpendReportBody({ report, range, by, onBy }: { report: SpendReportView; range: SpendPanelWindow; by: SpendTableBy; onBy: (by: SpendTableBy) => void }) {
  const lines = guardLines(report.guards, range);
  if (report.totals.runs === 0) {
    return (
      <>
        <EmptyState title={`No AI runs ended ${WINDOW_PHRASE[range]}`}>
          Each run of an agent, a review, the planner or the supervisor is recorded here when it ends: what it cost or how many requests it made,
          and whether it moved the work on.
        </EmptyState>
        <GuardList lines={lines} />
      </>
    );
  }
  const waste = wasteSentence(report);
  const reasons = topWasteReasons(report);
  const tasks = topTaskRows(report);
  const rows = groupRows(report);
  const partly = report.totals.reported && rows.some((r) => !r.reported);
  return (
    <>
      <p className="spend-waste" data-spend="waste">
        {waste ?? "No run is classified yet: their modules haven't recorded their results."}
      </p>
      <div className="spend-bars">
        {spendBars(report).map((bar) => (
          <SpendBarRow key={bar.unit} bar={bar} />
        ))}
      </div>
      <SpendLegend />
      {partly && (
        <p className="muted small" data-spend="partly-reported">
          Tokens and cost count only the runs whose adapter reports them; the rows of the others say &quot;{NOT_REPORTED}&quot;.
        </p>
      )}

      <div className="grid grid-2 spend-lists">
        <div>
          <h4>Where the waste went</h4>
          {reasons.length === 0 ? (
            <p className="muted small">No idle runs and no runs with no result.</p>
          ) : (
            <ul className="plain-list" data-spend="reasons">
              {reasons.map((r) => (
                <li key={r.key}>
                  <span className={`spend-dot spend-${r.class}`} aria-hidden="true" /> {r.label}:{" "}
                  <span className="muted">
                    {r.runs} run{r.runs === 1 ? "" : "s"}
                    {r.amount && `, ${r.amount}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4>Most attempts without a completion</h4>
          {tasks.length === 0 ? (
            <p className="muted small">No task needed another attempt.</p>
          ) : (
            <ul className="plain-list" data-spend="tasks">
              {tasks.map((t) => (
                <li key={t.task}>
                  <code>{t.task}</code> <span className="muted small">{t.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="section-head spend-table-head">
        <h4 className="m-0">By {SPEND_TABLE_GROUPS.find((g) => g.id === by)?.label.toLowerCase()}</h4>
        <Select
          compact
          aria-label="Group the AI spend table by"
          value={by}
          onChange={(e) => onBy(e.target.value as SpendTableBy)}
          options={SPEND_TABLE_GROUPS.map((g) => ({ value: g.id, label: g.label }))}
        />
      </div>
      <div className="table-wrap">
        <table className="table" data-spend="table">
          <thead>
            <tr>
              <th scope="col">{SPEND_TABLE_GROUPS.find((g) => g.id === by)?.label}</th>
              <th scope="col" className="align-right">Runs</th>
              <th scope="col" className="align-right">Productive</th>
              <th scope="col" className="align-right">Idle</th>
              <th scope="col" className="align-right">No result</th>
              <th scope="col" className="align-right">Wasted</th>
              <th scope="col" className="align-right">Requests</th>
              <th scope="col" className="align-right">Time</th>
              <th scope="col" className="align-right">Tokens</th>
              <th scope="col" className="align-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-spend-row={r.key}>
                <td>{r.code ? <code>{r.name}</code> : r.name}</td>
                <td className="align-right">{r.runs}</td>
                <td className="align-right">{r.productive}</td>
                <td className="align-right">{r.idle}</td>
                <td className="align-right">{r.noResult}</td>
                <td className="align-right">{r.waste}</td>
                <td className="align-right">{r.requests}</td>
                <td className="align-right">{r.minutes}</td>
                <td className={`align-right${r.reported ? "" : " muted"}`}>{r.tokens}</td>
                <td className={`align-right${r.reported ? "" : " muted"}`}>{r.cost}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="muted small" data-spend="losses">
        {lossesSentence(report)}
      </p>
      <GuardList lines={lines} />
    </>
  );
}

/** One unit's bar: its label, the stacked bar (a picture of the numbers beside it), and the numbers */
function SpendBarRow({ bar }: { bar: SpendBar }) {
  if (bar.notReported) {
    return (
      <div className="spend-bar-row" data-spend-bar={bar.unit}>
        <span className="spend-bar-label">{bar.label}</span>
        <span className="muted small spend-bar-numbers">{NOT_REPORTED}: the adapters of these runs don&apos;t report it</span>
      </div>
    );
  }
  return (
    <div className="spend-bar-row" data-spend-bar={bar.unit}>
      <span className="spend-bar-label">{bar.label}</span>
      <div className="spend-bar" aria-hidden="true">
        {bar.segments.map((s) =>
          s.share > 0 ? <span key={s.class} className={`spend-segment spend-${s.class}`} style={{ width: `${(s.share * 100).toFixed(2)}%` }} title={`${CLASS_LABEL[s.class]}: ${s.text}`} /> : null,
        )}
      </div>
      <span className="small spend-bar-numbers">
        {bar.totalText}:{" "}
        {bar.segments.map((s, i) => (
          <span key={s.class} className="muted">
            {i > 0 && " · "}
            {CLASS_LABEL[s.class].toLowerCase()} {s.text}
          </span>
        ))}
      </span>
    </div>
  );
}

function SpendLegend() {
  const classes: SpendSegmentClass[] = ["productive", "idle", "noResult"];
  return (
    <ul className="spend-legend muted small" aria-label="What the classes mean">
      {classes.map((c) => (
        <li key={c}>
          <span className={`spend-dot spend-${c}`} aria-hidden="true" /> <strong>{CLASS_LABEL[c]}</strong>: {CLASS_HINT[c]}
        </li>
      ))}
    </ul>
  );
}

function GuardList({ lines }: { lines: ReturnType<typeof guardLines> }) {
  const headingId = useId();
  return (
    <>
      <h4 id={headingId}>Guards against waste</h4>
      <ul className="plain-list spend-guards" aria-labelledby={headingId} data-spend="guards">
        {lines.map((g) => (
          <li key={g.guard} data-guard={g.guard} title={g.key}>
            <Badge tone={MODE_TONE[g.mode]}>{g.modeLabel}</Badge> <strong>{g.name}</strong>: <span className="muted">{g.text}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** An agent's Spend line in its detail (AgentDetail reads today's report by agent): its runs per class, and their cost or requests */
export function AgentSpendLineView({ report, agent, signedIn }: { report: SpendFetch; agent: string; signedIn: boolean | null }) {
  if (signedIn !== true) return <OwnerOnlyNotice text={OWNER_ONLY} />;
  if (report.error && !report.data) return <ErrorState what="its AI spend" error={report.error} />;
  if (!report.data) return <Loading what="its AI spend" />;
  return (
    <p className="small" data-spend="agent">
      {agentSpendLine(report.data, agent)} <a href={linkTo("home")}>All AI spend</a>
    </p>
  );
}
