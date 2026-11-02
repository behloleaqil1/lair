/**
 * Settings → Gates (docs/design/settings-v2.md): pipelines and their steps,
 * executors (GitHub Actions, local), triage (infra patterns, re-checks, flaky
 * policy), and placement (which machine runs what).
 *
 * Edits the `pipelines:`, `executors:`, `triage:`, and `placement:` blocks.
 * Every edit goes into the shell's draft, saved through its review.
 */
import { useEffect, useRef } from "react";
import type { FieldError, KnownValues, PathSegment, SettingsSection } from "../../shared/settings-types";
import { Card } from "../ui/Card";
import { Callout } from "../ui/Card";
import { revealIn, type PageFocus } from "./SettingsAi";
import { SettingsForm, type FormFocus } from "./SettingsForm";

interface Props {
  project: string;
  draft: Record<string, unknown>;
  sections: SettingsSection[];
  known: KnownValues;
  errors: FieldError[];
  disabled: boolean;
  onDraft: (next: Record<string, unknown>) => void;
  focus: PageFocus | null;
}

/** The section keys (from the registry) this page edits */
const GATES_SECTIONS = ["pipelines", "executors", "triage", "placement"];

/** Get the draft value at a path */
function getIn(draft: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = draft;
  for (const key of path) {
    if (current === undefined || current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Set a value at a path in the draft, returning a new draft */
function setIn(draft: Record<string, unknown>, path: PathSegment[], value: unknown): Record<string, unknown> {
  if (path.length === 0) return draft;
  const [head, ...rest] = path;
  const key = String(head);
  if (rest.length === 0) {
    if (value === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [key]: _, ...remaining } = draft;
      return remaining;
    }
    return { ...draft, [key]: value };
  }
  const child = draft[key];
  const nextChild = typeof child === "object" && child !== null ? (child as Record<string, unknown>) : {};
  return { ...draft, [key]: setIn(nextChild, rest, value) };
}

export function SettingsGates({ project: _project, draft, sections, known, errors, disabled, onDraft, focus }: Props) {
  const root = useRef<HTMLDivElement>(null);

  // Handle focus from search picks
  const key = focus?.key;
  const nonce = focus?.nonce;
  useEffect(() => {
    if (!key) return;
    if (key === "pipelines" || key.startsWith("pipelines.")) {
      revealIn(root.current, "[data-gates-pipelines]");
    } else if (key === "executors" || key.startsWith("executors.")) {
      revealIn(root.current, "[data-gates-executors]");
    } else if (key === "triage" || key.startsWith("triage.")) {
      revealIn(root.current, "[data-gates-triage]");
    } else if (key === "placement" || key.startsWith("placement.")) {
      revealIn(root.current, "[data-gates-placement]");
    }
  }, [key, nonce]);

  const gatesSections = sections.filter((s) => GATES_SECTIONS.includes(s.key));
  const gatesErrors = errors.filter((e) => GATES_SECTIONS.some((k) => e.path === k || e.path.startsWith(`${k}.`)));

  const onChange = (path: PathSegment[], value: unknown) => {
    onDraft(setIn(draft, path, value));
  };

  // Get block statuses for summary cards
  const pipelines = getIn(draft, ["pipelines"]) as Record<string, unknown> | undefined;
  const pipelineCount = pipelines ? Object.keys(pipelines).length : 0;

  const triage = getIn(draft, ["triage"]) as Record<string, unknown> | undefined;
  const triageEnabled = triage?.enabled === true;
  const triageMode = triage?.mode ?? "observe";

  const placement = getIn(draft, ["placement"]) as Record<string, unknown> | undefined;
  const placementEnabled = placement?.enabled === true;
  const placementMode = placement?.mode ?? "observe";

  // Build form focus for the classic form sections
  const formFocus: FormFocus | null =
    focus && key
      ? {
          section: key.split(".")[0],
          path: key,
          nonce: focus.nonce,
        }
      : null;

  return (
    <div ref={root} data-settings-gates="">
      {gatesErrors.length > 0 && (
        <Callout tone="danger" className="section-intro" title="The check refused these">
          {gatesErrors.map((e, i) => (
            <div key={i}>
              <code>{e.path}</code>: {e.message}
            </div>
          ))}
        </Callout>
      )}

      <Card title="Pipelines" data-gates-pipelines="" className="section-intro">
        <p className="muted small">
          Gate pipelines define what runs on each check: steps (commands), lanes (where they run), and timeouts.
          Each pipeline can run on GitHub Actions, local executors, or both.
        </p>
        <div className="stack-sm">
          <div className="row">
            <strong>Pipelines defined</strong>
            <span className="badge badge-neutral">{pipelineCount}</span>
          </div>
          {pipelineCount === 0 && (
            <Callout tone="info">
              No pipelines are defined. Add one to run checks through Lair's gate system.
            </Callout>
          )}
        </div>
      </Card>

      <Card title="Executors" data-gates-executors="" className="section-intro">
        <p className="muted small">
          How pipeline steps run: GitHub Actions (hosted or self-hosted runners), local (on this machine), or a
          fallback order. Configure timeouts, capacity limits, and worktree handling.
        </p>
      </Card>

      <Card title="Triage" data-gates-triage="" className="section-intro">
        <p className="muted small">
          Automatic diagnosis and handling of gate failures: infrastructure patterns (network, container, OOM),
          context failures, re-checks, flaky test policy, and bisection for culprit finding.
        </p>
        <div className="stack-sm">
          <div className="row">
            <strong>Triage</strong>
            {triageEnabled ? (
              <>
                <span className="badge badge-success">enabled</span>
                <span className="badge badge-neutral">{String(triageMode)}</span>
              </>
            ) : (
              <span className="badge badge-neutral">disabled</span>
            )}
          </div>
          {triageEnabled && triageMode === "observe" && (
            <Callout tone="info">
              Triage is observing: it reports what it would do but doesn't run re-checks or route failures.
              Set mode to "act" to enable automatic handling.
            </Callout>
          )}
        </div>
      </Card>

      <Card title="Placement" data-gates-placement="" className="section-intro">
        <p className="muted small">
          Which machine runs which gate jobs: lanes, machine probes, load balancing, and automatic job movement
          to finish sooner. Define classes to group similar jobs.
        </p>
        <div className="stack-sm">
          <div className="row">
            <strong>Placement</strong>
            {placementEnabled ? (
              <>
                <span className="badge badge-success">enabled</span>
                <span className="badge badge-neutral">{String(placementMode)}</span>
              </>
            ) : (
              <span className="badge badge-neutral">disabled</span>
            )}
          </div>
          {placementEnabled && placementMode === "observe" && (
            <Callout tone="info">
              Placement is observing: it reports where jobs would move but doesn't move them.
              Set mode to "act" and configure move_cmd to enable automatic placement.
            </Callout>
          )}
        </div>
      </Card>

      <Card title="All gates settings" data-gates-all="" className="section-intro">
        <p className="muted small">
          The full pipelines, executors, triage, and placement blocks. Advanced fields are folded by default.
        </p>
        <SettingsForm
          sections={gatesSections}
          draft={draft}
          known={known}
          errors={errors}
          unknownKeys={[]}
          disabled={disabled}
          onChange={onChange}
          focus={formFocus}
        />
      </Card>
    </div>
  );
}
