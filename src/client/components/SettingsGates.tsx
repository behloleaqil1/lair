/**
 * Settings → Gates (docs/design/settings-v2.md): pipelines and their steps,
 * executors (GitHub Actions, local), triage (infra patterns, re-checks, flaky
 * policy), and placement (which machine runs what).
 *
 * Edits the `pipelines:`, `executors:`, `triage:`, and `placement:` blocks.
 * Every edit goes into the shell's draft, saved through its review.
 */
import { useEffect, useState } from "react";
import type { FieldError, KnownValues, PathSegment, SettingsSection } from "../../shared/settings-types";
import { Card } from "../ui/Card";
import { Callout } from "../ui/Card";
import { Badge, StatusBadge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { getIn, setIn } from "../settings-form";
import { isPlainObject } from "../../shared/settings-rules";
import type { PageFocus } from "./SettingsAi";
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

/** A pipeline name the schema takes (PIPELINE_NAME in server/gates/project-pipelines.ts) */
const PIPELINE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export function SettingsGates({ draft, sections, known, errors, disabled, onDraft, focus }: Props) {
  // A search pick: SettingsForm unfolds, scrolls to and focuses the field itself
  const key = focus?.key;
  const [newPipeline, setNewPipeline] = useState("");
  // After "Add pipeline": the form opens the new pipeline's steps
  const [added, setAdded] = useState<FormFocus | null>(null);
  // A new search pick takes over from it
  const pickNonce = focus?.nonce;
  useEffect(() => setAdded(null), [key, pickNonce]);

  const gatesSections = sections.filter((s) => GATES_SECTIONS.includes(s.key));
  const gatesErrors = errors.filter((e) => GATES_SECTIONS.some((k) => e.path === k || e.path.startsWith(`${k}.`)));

  const onChange = (path: PathSegment[], value: unknown) => {
    onDraft(setIn(draft, path, value) as Record<string, unknown>);
  };

  // Get block statuses for summary cards
  const pipelines = getIn(draft, ["pipelines"]);
  const pipelineCount = isPlainObject(pipelines) ? Object.keys(pipelines).length : 0;

  const addPipeline = () => {
    const name = newPipeline;
    onDraft(setIn(draft, ["pipelines", name], { steps: [] }) as Record<string, unknown>);
    setNewPipeline("");
    setAdded({ section: "pipelines", path: `pipelines.${name}.steps`, nonce: Date.now() });
  };

  const triage = getIn(draft, ["triage"]) as Record<string, unknown> | undefined;
  const triageEnabled = triage?.enabled === true;
  const triageMode = triage?.mode ?? "observe";

  const placement = getIn(draft, ["placement"]) as Record<string, unknown> | undefined;
  const placementEnabled = placement?.enabled === true;
  const placementMode = placement?.mode ?? "observe";

  // Build form focus for the classic form sections
  const formFocus: FormFocus | null =
    added ??
    (focus && key
      ? {
          section: key.split(".")[0],
          path: key,
          nonce: focus.nonce,
        }
      : null);

  return (
    <div data-settings-gates="">
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
            <Badge plain>{pipelineCount}</Badge>
          </div>
          {pipelineCount === 0 && (
            <EmptyState
              framed={false}
              title="No pipelines yet"
              action={
                <div className="row">
                  <input
                    aria-label="New pipeline name"
                    className="input"
                    style={{ maxWidth: "14rem" }}
                    value={newPipeline}
                    disabled={disabled}
                    placeholder="e.g. ci"
                    onChange={(e) => setNewPipeline(e.target.value.trim())}
                  />
                  <Button size="sm" disabled={disabled || !PIPELINE_NAME.test(newPipeline)} onClick={addPipeline}>
                    Add pipeline
                  </Button>
                </div>
              }
            >
              A pipeline runs checks through Lair's gate system. Name it, then add its steps below.
            </EmptyState>
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
                <StatusBadge status="ok">enabled</StatusBadge>
                <Badge plain>{String(triageMode)}</Badge>
              </>
            ) : (
              <StatusBadge status="off">disabled</StatusBadge>
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
                <StatusBadge status="ok">enabled</StatusBadge>
                <Badge plain>{String(placementMode)}</Badge>
              </>
            ) : (
              <StatusBadge status="off">disabled</StatusBadge>
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
