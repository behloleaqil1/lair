/**
 * Machines (the old Machines and Nodes views): the project's machines with
 * their gate runners and, with placement on, its probe of each (up since,
 * load, lanes and the jobs on them); and on the Nodes tab the lair-node
 * machines registered with this server and the scheduler. A row opens its
 * detail (#/machines/<name>, #/machines/<node id>?tab=nodes).
 */
import { useMemo } from "react";
import { useApi } from "../hooks/useApi";
import { useMachinesWebSocket } from "../hooks/useWebSocket";
import { machineDetail, machineRows, nodeRows, type MachineRow, type NodeRow } from "../machines-view";
import { adviceText, eta } from "../placement-view";
import { linkTo } from "../router";
import type { MachineStatus } from "../../shared/types";
import type { ListNodesResponse } from "../../shared/server-types";
import type { PlacementStatus } from "../../shared/placement-types";
import { DataTable, type Column } from "./DataTable";
import { DetailPanel, DetailSection } from "./DetailPanel";
import { SectionHeader, type SectionProps } from "./Section";
import { usePlacement } from "./Placement";
import { EmptyState, ErrorState, KeyValues, Loading, Time, muted } from "./ui";

const MACHINE_COLUMNS: Column<MachineRow>[] = [
  { key: "id", label: "Machine", sort: (r) => r.id, render: (r) => <strong>{r.id}</strong> },
  { key: "type", label: "Type", sort: (r) => r.type, render: (r) => <span style={muted}>{r.type}</span> },
  {
    key: "state",
    label: "State",
    sort: (r) => (r.badge === "badge-success" ? 0 : r.badge === "badge-warning" ? 1 : 2),
    render: (r) => <span className={`badge ${r.badge}`}>{r.state}</span>,
  },
  { key: "runners", label: "Runners", render: (r) => <span style={muted}>{r.runners}</span> },
  { key: "load", label: "Load", render: (r) => <span style={muted}>{r.load}</span> },
  { key: "checked", label: "Checked", sort: (r) => r.lastCheck, render: (r) => <Time iso={r.lastCheck} /> },
];

const NODE_COLUMNS: Column<NodeRow>[] = [
  { key: "name", label: "Node", sort: (r) => r.name, render: (r) => <strong>{r.name}</strong> },
  { key: "status", label: "Status", sort: (r) => r.status, render: (r) => <span className={`badge ${r.badge}`}>{r.status}</span> },
  { key: "capacity", label: "Capacity", render: (r) => <span style={muted}>{r.capacity}</span> },
  { key: "used", label: "In use", render: (r) => <span style={muted}>{r.used}</span> },
  { key: "jobs", label: "Jobs", align: "right", sort: (r) => r.jobs, render: (r) => r.jobs },
  { key: "heartbeat", label: "Heartbeat", sort: (r) => r.lastHeartbeat, render: (r) => <Time iso={r.lastHeartbeat} /> },
];

export function MachinesSection({ project, refreshKey, route, modules, open }: SectionProps) {
  const machinesApi = useApi<MachineStatus[]>("/machines", project, refreshKey);
  // One array per REST answer, so the WebSocket hook isn't reset on every render
  const restMachines = useMemo(() => machinesApi.data ?? [], [machinesApi.data]);
  const { machines: wsMachines, connected } = useMachinesWebSocket(project, restMachines);
  const placement = usePlacement(project, refreshKey, modules?.placement !== true);
  const nodesApi = useApi<ListNodesResponse>("/nodes", "", refreshKey, { skip: route.tab !== "nodes" });
  // The WebSocket sends what GET /api/machines does; its hook types the runner lanes loosely
  const statuses = connected ? (wsMachines as MachineStatus[]) : restMachines;
  const rows = useMemo(() => machineRows(statuses, placement.data), [statuses, placement.data]);
  const nodes = nodeRows(nodesApi.data?.nodes ?? []);

  const body = () => {
    if (route.tab === "nodes") {
      if (nodesApi.loading && !nodesApi.data) return <Loading what="nodes" />;
      if (nodesApi.error && !nodesApi.data) return <ErrorState what="nodes" error={nodesApi.error} />;
      const scheduler = nodesApi.data?.scheduler;
      return (
        <>
          {scheduler && (
            <p style={muted}>
              Scheduler {scheduler.running ? "running" : "stopped"} · {scheduler.nodesOnline}/{scheduler.nodesTotal} nodes online ·{" "}
              {scheduler.queuedTasks} task(s) queued, {scheduler.runningJobs} job(s) running · agents {scheduler.activeAgents}/
              {scheduler.maxAgents}
              {scheduler.lastTickAt && (
                <>
                  {" "}
                  · last tick <Time iso={scheduler.lastTickAt} />
                </>
              )}
            </p>
          )}
          <div className="card">
            <DataTable
              label="Registered nodes"
              columns={NODE_COLUMNS}
              rows={nodes}
              rowKey={(r) => r.id}
              onOpen={(r) => open(r.id)}
              selected={route.detail}
              empty={<EmptyState title="No nodes registered">Run lair node join on a machine to connect it to this server.</EmptyState>}
            />
          </div>
        </>
      );
    }
    if (machinesApi.loading && !machinesApi.data) return <Loading what="machines" />;
    if (machinesApi.error && !machinesApi.data) return <ErrorState what="machines" error={machinesApi.error} />;
    return (
      <div className="card">
        <DataTable
          label="Machines"
          columns={MACHINE_COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          onOpen={(r) => open(r.id)}
          selected={route.detail}
          empty={<EmptyState title="No machines configured">Add them under machines: in the project&apos;s YAML.</EmptyState>}
        />
      </div>
    );
  };

  return (
    <div>
      <SectionHeader title="Machines" section="machines" route={route} modules={modules}>
        {placement.data?.enabled && <span style={muted}>Placement: {placement.data.mode ?? "off"}</span>}
      </SectionHeader>
      {body()}
      {route.detail && route.tab !== "nodes" && (
        <MachineDetailPanel id={route.detail} rows={rows} placement={placement.data} onClose={() => open(null)} />
      )}
      {route.detail && route.tab === "nodes" && (
        <NodeDetailPanel id={route.detail} rows={nodes} loading={nodesApi.loading} onClose={() => open(null)} />
      )}
    </div>
  );
}

function MachineDetailPanel({
  id,
  rows,
  placement,
  onClose,
}: {
  id: string;
  rows: MachineRow[];
  placement: PlacementStatus | null;
  onClose: () => void;
}) {
  const model = machineDetail(id, rows, placement);
  if (!model) {
    return (
      <DetailPanel title={id} onClose={onClose}>
        <EmptyState title={`No machine ${id}`}>It is not under machines: in this project&apos;s YAML, and placement does not probe it.</EmptyState>
      </DetailPanel>
    );
  }
  const { row, lanes, jobs } = model;
  const probe = row.probe;
  return (
    <DetailPanel title={row.id} subtitle={<span className={`badge ${row.badge}`}>{row.state}</span>} onClose={onClose}>
      <KeyValues
        rows={[
          ["Type", row.type],
          ["Runners", row.runners],
          ["Last gate", row.status?.lastGateTime ? <Time iso={row.status.lastGateTime} /> : null],
          ["Checked", row.lastCheck ? <Time iso={row.lastCheck} /> : null],
        ]}
      />
      {probe && (
        <DetailSection title="Placement probe">
          <KeyValues
            rows={[
              ["State", probe.state],
              ["Up since", probe.upSince ? <Time iso={probe.upSince} /> : null],
              ["Down since", probe.downSince ? <Time iso={probe.downSince} /> : null],
              ["Passing since", probe.passingSince ? <Time iso={probe.passingSince} /> : null],
              ["Last probe", probe.lastProbeAt ? <Time iso={probe.lastProbeAt} /> : null],
              ["Load", row.load],
              ["Last error", probe.lastError],
            ]}
          />
        </DetailSection>
      )}
      {lanes.length > 0 && (
        <DetailSection title="Lanes">
          <ul className="plain-list">
            {lanes.map(({ lane, slots }) => (
              <li key={lane.name}>
                <strong>{lane.name}</strong>
                {lane.serves.length > 0 ? ` (takes from ${lane.serves.join(", ")})` : ""}: {slots}
              </li>
            ))}
          </ul>
        </DetailSection>
      )}
      {lanes.length > 0 && (
        <DetailSection title="Jobs on its lanes">
          {jobs.length === 0 ? (
            <p style={muted}>None queued or running.</p>
          ) : (
            <table className="table">
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <a href={linkTo("gates", job.id)}>
                        <code>{job.id}</code>
                      </a>
                      <div style={muted}>
                        {job.lane} · {job.status}
                      </div>
                    </td>
                    <td style={muted}>
                      {job.status === "queued" ? `starts ${eta(job.expectedStart)}` : `finishes ${eta(job.expectedFinish)}`}
                      <div>{adviceText(job, placement?.mode ?? null)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DetailSection>
      )}
    </DetailPanel>
  );
}

function NodeDetailPanel({ id, rows, loading, onClose }: { id: string; rows: NodeRow[]; loading: boolean; onClose: () => void }) {
  const row = rows.find((r) => r.id === id);
  if (!row) {
    return (
      <DetailPanel title={id} onClose={onClose}>
        {loading ? <Loading what={`node ${id}`} /> : <EmptyState title={`No node ${id}`}>It is not registered with this server.</EmptyState>}
      </DetailPanel>
    );
  }
  const node = row.node;
  return (
    <DetailPanel title={row.name} subtitle={<span className={`badge ${row.badge}`}>{row.status}</span>} onClose={onClose}>
      <KeyValues
        rows={[
          ["Id", <code key="i">{node.id}</code>],
          ["System", [node.os, node.arch].filter(Boolean).join(" ") || null],
          ["Version", node.version ?? null],
          ["Capacity", `${row.capacity}, ${node.capacity.diskGb} GB disk${node.capacity.gpuCount > 0 ? `, ${node.capacity.gpuCount} GPU` : ""}`],
          ["In use", row.used],
          ["Active jobs", String(row.jobs)],
          ["Container runtime", row.runtime],
          ["Registered", <Time key="r" iso={node.registeredAt} />],
          ["Last heartbeat", row.lastHeartbeat ? <Time iso={row.lastHeartbeat} /> : null],
        ]}
      />
    </DetailPanel>
  );
}
