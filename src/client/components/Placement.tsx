/**
 * Placement (/api/placement/status, read only) in the Gates section's
 * Placement tab: the mode, config errors and the latest moves (or, in
 * observe mode, advice); a move opens its gate's detail. The probes of each
 * machine are in the Machines section. See docs/configuration.md#placement.
 */
import { useApi } from "../hooks/useApi";
import { latestMoves, modeText, moveBadge } from "../placement-view";
import type { PlacementMove, PlacementStatus } from "../../shared/placement-types";
import { DataTable, type Column } from "./DataTable";
import { Time } from "./ui";
import { Badge } from "../ui/Badge";

export function usePlacement(project: string, refreshKey: number, skip = false) {
  return useApi<PlacementStatus>("/placement/status", project, refreshKey, { skip });
}

const MOVE_COLUMNS: Column<PlacementMove>[] = [
  { key: "at", label: "When", sort: (m) => m.at, render: (m) => <Time iso={m.at} /> },
  {
    key: "status",
    label: "Status",
    sort: (m) => m.status,
    render: (m) => <Badge tone={moveBadge(m)}>{m.status.replace("_", " ")}</Badge>,
  },
  { key: "gate", label: "Gate", sort: (m) => m.gateId, render: (m) => <code>{m.gateId}</code> },
  {
    key: "decision",
    label: "Decision",
    render: (m) => (
      <span className="small">
        {m.explanation}
        {m.error && <span className="text-danger block">{m.error}</span>}
      </span>
    ),
  },
];

/** The mode, config errors and the latest moves (or advice). */
export function PlacementMoves({ status, openGate }: { status: PlacementStatus | null; openGate: (id: string) => void }) {
  if (!status) return null;
  return (
    <div className="card">
      <p className="muted small">
        Mode: {modeText(status)}
        {status.lastTick && (
          <>
            {" "}
            · last check <Time iso={status.lastTick.at} />
          </>
        )}
      </p>
      {status.errors.length > 0 && (
        <ul className="text-danger small">
          {status.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {status.lastError && <p className="text-danger small">{status.lastError}</p>}
      <DataTable
        label="Placement moves"
        columns={MOVE_COLUMNS}
        rows={latestMoves(status, 50)}
        rowKey={(m) => m.id}
        onOpen={(m) => openGate(m.gateId)}
        empty={<p className="muted small">No moves yet: placement moves (or, in observe mode, advises) a queued job when another lane would finish it sooner.</p>}
      />
    </div>
  );
}
