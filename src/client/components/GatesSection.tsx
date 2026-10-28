/**
 * Gates: the queue (the project's gate queue in gates_dir, any lane its
 * request files name), the results of the last 24 hours, and, when their
 * modules are on, Lair's pipelines, triage and placement. Every row opens
 * the gate's detail (#/gates/<id>), on the tab it was opened from.
 */
import { useMemo } from "react";
import { useApi } from "../hooks/useApi";
import { useGatesWebSocket } from "../hooks/useWebSocket";
import { laneGates, queueLanes, recentResults, statusBadge } from "../gates-view";
import { adviceText, jobsById } from "../placement-view";
import { trackOf } from "../gate-detail-view";
import { tabAvailable, tabDef } from "../nav";
import type { Gate, GateResult } from "../../shared/types";
import { DataTable, type Column } from "./DataTable";
import { SectionHeader, type SectionProps } from "./Section";
import { GateDetail } from "./GateDetail";
import { PipelineRuns } from "./PipelineRuns";
import { Triage } from "./Triage";
import { PlacementMoves, usePlacement } from "./Placement";
import { EmptyState, ErrorState, Loading, ModuleOff, Time } from "./ui";
import { Badge } from "../ui/Badge";

interface GatesData {
  queue: Gate[];
  results: GateResult[];
}

const RESULT_COLUMNS: Column<GateResult>[] = [
  {
    key: "result",
    label: "Result",
    sort: (r) => r.rc,
    render: (r) => <Badge tone={r.rc === 0 ? "badge-success" : "badge-error"}>{r.rc === 0 ? "passed" : `failed (${r.rc})`}</Badge>,
  },
  { key: "finished", label: "Finished", sort: (r) => r.finishedAt, render: (r) => <Time iso={r.finishedAt} /> },
  { key: "track", label: "Track", sort: (r) => trackOf(r.id), render: (r) => trackOf(r.id) },
  { key: "id", label: "Gate", render: (r) => <code className="small">{r.id}</code> },
  {
    key: "failed",
    label: "Failed steps",
    render: (r) => <span className="text-danger small">{r.failedSteps?.join(", ") || "—"}</span>,
  },
];

export function GatesSection({ project, refreshKey, route, modules, readOnly, open }: SectionProps) {
  const gates = useApi<GatesData>("/gates", project, refreshKey);
  const restQueue = useMemo(() => gates.data?.queue ?? [], [gates.data]);
  const { gates: wsQueue, connected } = useGatesWebSocket(project, restQueue);
  const placementOn = modules?.placement === true;
  const placement = usePlacement(project, refreshKey, !placementOn);
  const placed = useMemo(() => jobsById(placement.data), [placement.data]);

  const queue = connected ? wsQueue : restQueue;
  const running = queue.filter((g) => g.status === "running").length;
  const queued = queue.filter((g) => g.status === "queued").length;
  const tab = tabDef("gates", route.tab);

  const queueColumns: Column<Gate>[] = [
    {
      key: "status",
      label: "Status",
      sort: (g) => (g.status === "running" ? 0 : g.status === "queued" ? 1 : 2),
      render: (g) => <Badge tone={statusBadge(g.status)}>{g.status}</Badge>,
    },
    { key: "lane", label: "Lane", sort: (g) => g.lane, render: (g) => g.lane },
    { key: "priority", label: "Priority", align: "right", sort: (g) => g.priority, render: (g) => g.priority },
    { key: "track", label: "Track", sort: (g) => g.track ?? g.id, render: (g) => g.track ?? <code>{g.id}</code> },
    { key: "step", label: "Step", render: (g) => <span className="muted small">{g.currentStep ?? "—"}</span> },
    { key: "age", label: "Submitted", sort: (g) => g.startTime, render: (g) => <Time iso={g.startTime} /> },
    ...(placementOn
      ? [
          {
            key: "placement",
            label: "Placement",
            render: (g: Gate) => (
              <span className="muted small" title={placed.get(g.id)?.advice?.explanation}>
                {adviceText(placed.get(g.id), placement.data?.mode ?? null)}
              </span>
            ),
          },
        ]
      : []),
  ];

  const body = () => {
    if (!tabAvailable("gates", route.tab, modules)) return <ModuleOff what={tab?.label ?? "This tab"} enable={tab?.enable ?? ""} />;
    switch (route.tab) {
      case "pipelines":
        return <PipelineRuns project={project} refreshKey={refreshKey} openRun={(id) => open(id)} />;
      case "triage":
        return <Triage project={project} refreshKey={refreshKey} openGate={(id) => open(id)} />;
      case "placement":
        return placement.error && !placement.data ? (
          <ErrorState what="placement" error={placement.error} />
        ) : (
          <PlacementMoves status={placement.data} openGate={(id) => open(id)} />
        );
    }
    if (gates.loading && !gates.data && queue.length === 0) return <Loading what="the gate queue" />;
    if (gates.error && !gates.data) return <ErrorState what="the gate queue" error={gates.error} />;
    if (route.tab === "results") {
      return (
        <div className="card">
          <DataTable
            label="Gate results of the last 24 hours"
            columns={RESULT_COLUMNS}
            rows={recentResults(gates.data?.results ?? [])}
            rowKey={(r) => r.id}
            onOpen={(r) => open(r.id)}
            selected={route.detail}
            initialSort={{ key: "finished", dir: "desc" }}
            empty={
              <EmptyState title="No results in the last 24 hours">
                A result is a gates_dir/results/&lt;gate id&gt;.rc file (its exit code), with its log beside it as
                &lt;gate id&gt;.log.
              </EmptyState>
            }
          />
        </div>
      );
    }
    return (
      <div className="card">
        <DataTable
          label="Gate queue"
          columns={queueColumns}
          rows={queue}
          rowKey={(g) => `${g.lane}.${g.priority}.${g.id}.${g.status}`}
          onOpen={(g) => open(g.id)}
          initialSort={{ key: "status", dir: "asc" }}
          empty={
            <EmptyState title="The queue is empty">
              A gate request is a gates_dir/queue/&lt;lane&gt;.&lt;priority&gt;.&lt;gate id&gt;.req file; the project&apos;s gate
              runner takes it (.req.run while it runs) and writes the result.
            </EmptyState>
          }
        />
      </div>
    );
  };

  return (
    <div>
      <SectionHeader title="Gates" section="gates" route={route} modules={modules}>
        <span className="muted small">
          {running} running, {queued} queued
          {queueLanes(queue).length > 0 &&
            ` · ${queueLanes(queue)
              .map((lane) => `${lane} ${laneGates(queue, lane).length}`)
              .join(", ")}`}
        </span>
      </SectionHeader>
      {body()}
      {route.detail && (
        <GateDetail
          id={route.detail}
          project={project}
          refreshKey={refreshKey}
          readOnly={readOnly}
          triageOn={modules?.triage === true}
          onClose={() => open(null)}
        />
      )}
    </div>
  );
}
