/**
 * Home: what needs the owner (open decisions, holds, failed gates, PRs ready
 * to merge, config problems, agents in trouble), the fleet at a glance (one
 * tile per section, each a link), the problems Lair sees, and the recent
 * activity. Its Activity tab is the bus's reports and the control audit log;
 * its Health tab (with the watchdog on) the SLOs, breaches and playbook runs.
 */
import { useMemo, type ReactNode } from "react";
import { useApi } from "../hooks/useApi";
import { gitDateToIso } from "../time";
import { needsYou, type NeedItem } from "../home-view";
import { workCounts, workRows } from "../work-view";
import { latestFailures } from "../gate-detail-view";
import { hostRows, reviewRows } from "../pr-view";
import { machineCounts, machineRows } from "../machines-view";
import { recentResults } from "../gates-view";
import { linkTo } from "../router";
import { tabAvailable, tabDef } from "../nav";
import type { Dragon, Gate, GateResult, MachineStatus, OverviewData, PullRequest } from "../../shared/types";
import type { AgentsStatusView } from "../../shared/agents-types";
import type { Decision } from "../../shared/decision-types";
import type { DeliveryProjectStatus } from "../../shared/delivery-types";
import type { ConfigStatusView } from "../../shared/lifecycle-types";
import type { MergeHold, PrSummary } from "../../shared/review-types";
import { SectionHeader, type SectionProps } from "./Section";
import { LiveFeed } from "./LiveFeed";
import { Activity } from "./Activity";
import { Health } from "./Health";
import { ErrorState, Loading, ModuleOff, Time, muted } from "./ui";

interface WatchdogSummary {
  enabled: boolean;
  slos: { state: string; openBreaches: number }[];
}

const TONE_ICON: Record<NeedItem["tone"], string> = { error: "🔴", warning: "🟡", neutral: "⚪" };

function Tile({ href, value, label, detail, tone }: { href: string; value: string; label: string; detail?: string; tone?: string }) {
  return (
    <a href={href} className="card stat tile">
      <div className="stat-value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
      {detail && <div className="tile-detail">{detail}</div>}
    </a>
  );
}

export function Home(props: SectionProps) {
  const { route, modules } = props;
  const tab = tabDef("home", route.tab);
  let body: ReactNode;
  if (!tabAvailable("home", route.tab, modules)) body = <ModuleOff what={tab?.label ?? "This tab"} enable={tab?.enable ?? ""} />;
  else if (route.tab === "activity") body = <Activity project={props.project} refreshKey={props.refreshKey} />;
  else if (route.tab === "health") body = <Health project={props.project} refreshKey={props.refreshKey} />;
  else body = <HomeOverview {...props} />;
  return (
    <div>
      <SectionHeader title="Home" section="home" route={route} modules={modules} />
      {body}
    </div>
  );
}

function HomeOverview({ project, refreshKey, modules }: SectionProps) {
  // The git host is asked once a minute, not on every 10 s refresh
  const slowKey = Math.floor(refreshKey / 60_000);
  const reviewOn = modules?.review === true;
  const overview = useApi<OverviewData>("/overview", project, slowKey);
  const dragons = useApi<Dragon[]>("/dragons", project, refreshKey);
  const agents = useApi<AgentsStatusView>("/agents/status", project, refreshKey, { skip: modules?.agents !== true });
  const gates = useApi<{ queue: Gate[]; results: GateResult[] }>("/gates", project, refreshKey);
  const machines = useApi<MachineStatus[]>("/machines", project, refreshKey);
  const decisions = useApi<Decision[]>("/decisions?limit=200", "", refreshKey);
  const holds = useApi<MergeHold[]>("/review/holds", project, refreshKey, { skip: !reviewOn });
  const reviewPrs = useApi<PrSummary[]>("/review/prs", project, slowKey, { skip: !reviewOn });
  const hostPrs = useApi<PullRequest[]>("/prs", project, slowKey, { skip: reviewOn || modules?.github !== true });
  const delivery = useApi<DeliveryProjectStatus>("/delivery/status", project, refreshKey, { skip: modules?.delivery !== true });
  const config = useApi<ConfigStatusView>("/config/status", "", refreshKey);
  const watchdog = useApi<WatchdogSummary>("/watchdog/status", project, refreshKey, { skip: modules?.watchdog !== true });

  const agentsView = agents.data?.enabled ? agents.data : null;
  const work = useMemo(() => workRows(dragons.data ?? [], agentsView), [dragons.data, agentsView]);
  const queue = gates.data?.queue ?? [];
  const failures = latestFailures(recentResults(gates.data?.results ?? []), queue);
  const prs = reviewOn ? reviewRows(reviewPrs.data ?? [], {}) : hostRows(hostPrs.data ?? []);
  const items = needsYou({
    project,
    decisions: decisions.data ?? [],
    reviewHolds: holds.data ?? [],
    agents: agentsView,
    delivery: delivery.data ?? null,
    failures,
    prs,
    configProblems: config.data?.problems ?? [],
    work,
  });

  const counts = workCounts(work);
  const machineTally = machineCounts(machineRows(machines.data ?? [], null));
  const running = queue.filter((g) => g.status === "running").length;
  const queued = queue.filter((g) => g.status === "queued").length;
  const breaches = (watchdog.data?.slos ?? []).reduce((n, s) => n + s.openBreaches, 0);

  return (
    <>
      <div className="card" data-card="needs-you">
        <h3>Needs you</h3>
        {decisions.error && !decisions.data && <ErrorState what="the decisions" error={decisions.error} />}
        {items.length === 0 ? (
          <p style={{ color: "var(--success)" }}>✓ Nothing needs you right now.</p>
        ) : (
          <ul className="needs-list">
            {items.map((item) => (
              <li key={item.key} className={`need need-${item.tone}`}>
                <span aria-hidden="true">{TONE_ICON[item.tone]}</span>
                <a href={item.href}>{item.title}</a>
                {item.detail && <span style={muted}>{item.detail}</span>}
                {item.at && (
                  <span style={muted}>
                    <Time iso={item.at} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-4 tiles">
        <Tile
          href={linkTo("work")}
          value={`${counts.busy}/${counts.total}`}
          label="Agents working"
          detail={counts.attention > 0 ? `${counts.attention} need a look` : undefined}
          tone={counts.attention > 0 ? "error" : undefined}
        />
        <Tile
          href={linkTo("gates")}
          value={`${running} · ${queued}`}
          label="Gates running · queued"
          detail={failures.length > 0 ? `${failures.length} track(s) failing` : undefined}
          tone={failures.length > 0 ? "error" : undefined}
        />
        <Tile
          href={linkTo("machines")}
          value={`${machineTally.up}/${machineTally.total}`}
          label="Machines up"
          tone={machineTally.up < machineTally.total ? "warning" : undefined}
        />
        {modules?.watchdog ? (
          <Tile
            href={linkTo("home", null, "health")}
            value={String(breaches)}
            label="Open breaches"
            detail="Watchdog"
            tone={breaches > 0 ? "error" : undefined}
          />
        ) : (
          <Tile
            href={linkTo("prs")}
            value={String(prs.filter((p) => p.readiness.group === "ready").length)}
            label={reviewOn ? "PRs ready to merge" : "PRs with a passed gate"}
          />
        )}
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>Problems</h3>
          {overview.loading && !overview.data ? (
            <Loading what="the overview" />
          ) : overview.error && !overview.data ? (
            <ErrorState what="the overview" error={overview.error} />
          ) : (overview.data?.problems ?? []).length === 0 ? (
            <p style={{ color: "var(--success)" }}>✓ No problems detected</p>
          ) : (
            (overview.data?.problems ?? []).map((problem, i) => (
              <div key={i} className={`problem problem-${problem.severity}`}>
                <span className="problem-icon">{problem.severity === "error" ? "🔴" : "🟡"}</span>
                <div className="problem-content">
                  <div className="problem-message">{problem.message}</div>
                  {problem.details && <div className="problem-details">{problem.details}</div>}
                </div>
              </div>
            ))
          )}
          {overview.data && (
            <p style={{ ...muted, marginTop: "0.75rem" }}>
              main at <code>{overview.data.mainHead}</code>
              {gitDateToIso(overview.data.mainDate) && (
                <>
                  , <Time iso={gitDateToIso(overview.data.mainDate)} />
                </>
              )}
              {overview.data.localStackHead && (
                <>
                  {" "}
                  · local stack at <code>{overview.data.localStackHead}</code>
                </>
              )}
            </p>
          )}
        </div>
        <div className="card">
          <h3>Merged in the last 24 hours</h3>
          {(overview.data?.recentMerges ?? []).length === 0 ? (
            <p style={muted}>No merges in the last 24 hours.</p>
          ) : (
            <ul className="plain-list">
              {(overview.data?.recentMerges ?? []).slice(0, 8).map((pr) => (
                <li key={pr.number}>
                  <span style={muted}>#{pr.number}</span> {pr.title}{" "}
                  <span style={muted}>
                    <Time iso={pr.mergedAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <LiveFeed project={project} limit={10} />
      <p style={muted}>
        <a href={linkTo("home", null, "activity")}>All activity</a>
      </p>
    </>
  );
}
