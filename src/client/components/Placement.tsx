/**
 * Placement in the Gates and Machines views (/api/placement/status, read
 * only): the latest moves and the mode in Gates, and each machine's probe
 * state, load and lanes in Machines. See docs/configuration.md#placement.
 */
import { useApi } from "../hooks/useApi";
import {
  laneSlots,
  latestMoves,
  machineBadge,
  machineLoad,
  machineState,
  modeText,
  moveBadge,
} from "../placement-view";
import type { PlacementStatus } from "../../shared/placement-types";

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };

export function usePlacement(project: string, refreshKey: number) {
  return useApi<PlacementStatus>("/placement/status", project, refreshKey);
}

/** Gates view: the mode, config errors and the latest moves (or, in observe mode, advice). */
export function PlacementMoves({ status }: { status: PlacementStatus | null }) {
  if (!status || (!status.enabled && status.errors.length === 0)) return null;
  const moves = latestMoves(status);
  return (
    <div className="card">
      <h3>Placement</h3>
      <p style={muted}>
        Mode: {modeText(status)}
        {status.lastTick ? ` · last check ${new Date(status.lastTick.at).toLocaleTimeString()}` : ""}
      </p>
      {status.errors.length > 0 && (
        <ul style={{ color: "var(--error)", fontSize: "0.85rem" }}>
          {status.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {status.lastError && <p style={{ color: "var(--error)", fontSize: "0.85rem" }}>{status.lastError}</p>}
      {moves.length === 0 ? (
        <p style={muted}>No moves yet</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Status</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {moves.map((move) => (
              <tr key={move.id}>
                <td style={muted}>{new Date(move.at).toLocaleTimeString()}</td>
                <td>
                  <span className={`badge ${moveBadge(move)}`}>{move.status.replace("_", " ")}</span>
                </td>
                <td style={{ fontSize: "0.85rem" }}>
                  {move.explanation}
                  {move.error && <div style={{ color: "var(--error)" }}>{move.error}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Machines view: placement's probe state, load and lanes per machine. */
export function PlacementMachines({ project, refreshKey }: { project: string; refreshKey: number }) {
  const { data: status } = usePlacement(project, refreshKey);
  if (!status || !status.enabled) return null;
  return (
    <div className="card">
      <h3>Placement</h3>
      <p style={muted}>Mode: {modeText(status)}</p>
      <table className="table">
        <thead>
          <tr>
            <th>Machine</th>
            <th>Probe</th>
            <th>Load</th>
            <th>Lanes</th>
          </tr>
        </thead>
        <tbody>
          {status.machines.map((m) => (
            <tr key={m.id}>
              <td>{m.id}</td>
              <td>
                <span className={`badge ${machineBadge(m)}`}>{m.state}</span>{" "}
                <span style={muted}>{machineState(m)}</span>
                {m.lastError && <div style={{ color: "var(--error)", fontSize: "0.85rem" }}>{m.lastError}</div>}
              </td>
              <td style={muted}>{machineLoad(m)}</td>
              <td style={{ fontSize: "0.85rem" }}>
                {status.lanes
                  .filter((lane) => lane.machine === m.id)
                  .map((lane) => (
                    <div key={lane.name}>
                      <strong>{lane.name}</strong>
                      {lane.serves.length > 0 ? ` (takes from ${lane.serves.join(", ")})` : ""}: {laneSlots(lane)}
                    </div>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
