/**
 * Settings → Work (docs/design/settings-v2.md): where tasks come from, agent
 * limits, recovery budgets, and the capacity check. Edits the `agents:`
 * block (agents.fill, agents.recovery, agents.retries, agents.budgets, ...)
 * and related coordination settings.
 *
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
const WORK_SECTIONS = ["agents"];

/** Get the draft value at a path, e.g. draft.agents.fill */
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
      const { [key]: _, ...remaining } = draft;
      return remaining;
    }
    return { ...draft, [key]: value };
  }
  const child = draft[key];
  const nextChild = typeof child === "object" && child !== null ? (child as Record<string, unknown>) : {};
  return { ...draft, [key]: setIn(nextChild, rest, value) };
}

export function SettingsWork({ project, draft, sections, known, errors, disabled, onDraft, focus }: Props) {
  const root = useRef<HTMLDivElement>(null);

  // Handle focus from search picks
  const key = focus?.key;
  const nonce = focus?.nonce;
  useEffect(() => {
    if (!key) return;
    // Find the card that holds this key
    if (key.startsWith("agents.fill")) {
      revealIn(root.current, "[data-work-fill]");
    } else if (key.startsWith("agents.recovery") || key.startsWith("agents.retries")) {
      revealIn(root.current, "[data-work-recovery]");
    } else if (key.startsWith("agents.budgets")) {
      revealIn(root.current, "[data-work-budgets]");
    } else if (key.startsWith("agents.")) {
      revealIn(root.current, "[data-work-agents]");
    }
  }, [key, nonce]);

  const workSections = sections.filter((s) => WORK_SECTIONS.includes(s.key));
  const workErrors = errors.filter((e) => WORK_SECTIONS.some((k) => e.path === k || e.path.startsWith(`${k}.`)));

  const onChange = (path: PathSegment[], value: unknown) => {
    onDraft(setIn(draft, path, value));
  };

  // Get the agents block for display
  const agentsBlock = getIn(draft, ["agents"]) as Record<string, unknown> | undefined;
  const fillEnabled = agentsBlock?.fill !== undefined && (agentsBlock.fill as Record<string, unknown>)?.enabled === true;
  const agentsEnabled = agentsBlock?.enabled === true;

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
    <div ref={root} data-settings-work="">
      {workErrors.length > 0 && (
        <Callout tone="danger" className="section-intro" title="The check refused these">
          {workErrors.map((e, i) => (
            <div key={i}>
              <code>{e.path}</code>: {e.message}
            </div>
          ))}
        </Callout>
      )}

      <Card title="Task source" data-work-fill="" className="section-intro">
        <p className="muted small">
          Where new tasks come from: a tasks file (list.txt) that fill reads, or the planner. Fill starts agents
          automatically when tasks are ready and capacity is available.
        </p>
        <div className="stack-sm">
          <div className="row">
            <strong>Fill</strong>
            {fillEnabled ? (
              <span className="badge badge-success">enabled</span>
            ) : (
              <span className="badge badge-neutral">disabled</span>
            )}
          </div>
          {agentsEnabled === false && fillEnabled && (
            <Callout tone="warning">Fill is enabled but agents.enabled is false: fill won't start any runs.</Callout>
          )}
        </div>
      </Card>

      <Card title="Recovery and retries" data-work-recovery="" className="section-intro">
        <p className="muted small">
          When a run crashes or fails to start, how many times it is recovered (same session, then fresh), and the
          backoff between attempts.
        </p>
      </Card>

      <Card title="Budgets" data-work-budgets="" className="section-intro">
        <p className="muted small">
          Spending limits per day or month, for the project and per agent. Soft limits warn; hard limits stop runs.
        </p>
      </Card>

      <Card title="All agents settings" data-work-agents="" className="section-intro">
        <p className="muted small">
          The full agents block, including timeouts, locks, failover patterns, transient handling, and usage patterns.
          Advanced fields are folded by default.
        </p>
        <SettingsForm
          sections={workSections}
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
