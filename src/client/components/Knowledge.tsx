/**
 * Knowledge: lessons list grouped by signal kind, with status and scope
 * badges, filters, and detail view with related lessons.
 *
 * Owner-only: requires owner auth (the lessons API is requireOwner).
 */
import { useEffect, useState } from "react";
import type { LessonsListView, LessonSummary, LessonDetailView, LessonStatus, LessonScope } from "../../shared/lessons-types";
import { listLessons, getLesson, approveLesson, retireLesson } from "../lessons-api";
import {
  groupBySignalKind,
  STATUS_LABELS,
  STATUS_TONES,
  SCOPE_LABELS,
  SIGNAL_KIND_LABELS,
  formatDate,
  summaryText,
  canApprove,
  canRetire,
  DEFAULT_FILTER,
  type KnowledgeFilter,
} from "../knowledge-view";
import { SectionHeader, type SectionProps } from "./Section";
import { ErrorState, Loading } from "./ui";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field } from "../ui/Field";
import { Select } from "../ui/Select";

export function Knowledge({ project, refreshKey, route, modules, open }: SectionProps) {
  const [view, setView] = useState<LessonsListView | null>(null);
  const [detail, setDetail] = useState<LessonDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<KnowledgeFilter>(DEFAULT_FILTER);
  const [reload, setReload] = useState(0);

  // Load lessons list
  useEffect(() => {
    let cancelled = false;
    const params = {
      status: filter.status === "all" ? undefined : filter.status,
      scope: filter.scope === "all" ? undefined : filter.scope,
    };
    listLessons(project, params)
      .then((data) => {
        if (!cancelled) {
          setView(data);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Network error");
      });
    return () => { cancelled = true; };
  }, [project, refreshKey, reload, filter]);

  // Load detail when route.detail changes
  useEffect(() => {
    if (!route.detail) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    getLesson(route.detail)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load lesson");
      });
    return () => { cancelled = true; };
  }, [route.detail, reload]);

  const handleApprove = async (id: string) => {
    try {
      await approveLesson(id);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to approve");
    }
  };

  const handleRetire = async (id: string) => {
    try {
      await retireLesson(id);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to retire");
    }
  };

  const handleSelectLesson = (id: string) => {
    open(id);
  };

  const handleCloseDetail = () => {
    open(null);
  };

  const body = () => {
    if (!view && error) return <ErrorState what="the lessons" error={error} />;
    if (!view) return <Loading what="lessons" />;

    const grouped = groupBySignalKind(view.lessons);

    return (
      <>
        {error && <ErrorState what="the latest data" error={error} />}
        <p className="summary-text">{summaryText(view.counts)}</p>
        <Filters filter={filter} onChange={setFilter} />
        {detail && route.detail && (
          <LessonDetail
            detail={detail}
            onApprove={handleApprove}
            onRetire={handleRetire}
            onClose={handleCloseDetail}
            onSelectRelated={handleSelectLesson}
          />
        )}
        <LessonsGrouped grouped={grouped} onSelect={handleSelectLesson} />
      </>
    );
  };

  return (
    <div>
      <SectionHeader title="Knowledge" section="knowledge" route={route} modules={modules} />
      {body()}
    </div>
  );
}

function Filters({ filter, onChange }: { filter: KnowledgeFilter; onChange: (f: KnowledgeFilter) => void }) {
  return (
    <div className="filters" role="group" aria-label="Filter lessons">
      <Field label="Status">
        <Select
          value={filter.status}
          onChange={(e) => onChange({ ...filter, status: e.target.value as LessonStatus | "all" })}
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "proposed", label: "Proposed" },
            { value: "retired", label: "Retired" },
          ]}
        />
      </Field>
      <Field label="Scope">
        <Select
          value={filter.scope}
          onChange={(e) => onChange({ ...filter, scope: e.target.value as LessonScope | "all" })}
          options={[
            { value: "all", label: "All" },
            { value: "built-in", label: "Built-in" },
            { value: "project", label: "Project" },
          ]}
        />
      </Field>
    </div>
  );
}

function LessonsGrouped({
  grouped,
  onSelect,
}: {
  grouped: Map<string, LessonSummary[]>;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="lessons-grouped">
      {Array.from(grouped.entries()).map(([kind, lessons]) => (
        <Card key={kind} className="signal-kind-group">
          <h2>{SIGNAL_KIND_LABELS[kind] ?? kind}</h2>
          <table className="data-table" role="grid" aria-label={`${SIGNAL_KIND_LABELS[kind] ?? kind} lessons`}>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Title</th>
                <th scope="col">Signal</th>
                <th scope="col">Status</th>
                <th scope="col">Scope</th>
                <th scope="col">Matches</th>
                <th scope="col">Last Match</th>
              </tr>
            </thead>
            <tbody>
              {lessons.map((l) => (
                <LessonRow key={l.id} lesson={l} onSelect={onSelect} />
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

function LessonRow({ lesson, onSelect }: { lesson: LessonSummary; onSelect: (id: string) => void }) {
  return (
    <tr
      className="lesson-row clickable"
      tabIndex={0}
      role="button"
      aria-label={`View ${lesson.title}`}
      onClick={() => onSelect(lesson.id)}
      onKeyDown={(e) => e.key === "Enter" && onSelect(lesson.id)}
    >
      <td>{lesson.id}</td>
      <td>{lesson.title}</td>
      <td>
        <Badge tone="neutral">{SIGNAL_KIND_LABELS[lesson.signal.kind] ?? lesson.signal.kind}</Badge>{" "}
        {lesson.signal.value}
      </td>
      <td>
        <Badge tone={STATUS_TONES[lesson.status]}>
          {STATUS_LABELS[lesson.status]}
        </Badge>
      </td>
      <td>
        <Badge tone="info" plain>
          {SCOPE_LABELS[lesson.scope]}
        </Badge>
      </td>
      <td>{lesson.matchCount}</td>
      <td>{formatDate(lesson.lastMatchAt)}</td>
    </tr>
  );
}

function LessonDetail({
  detail,
  onApprove,
  onRetire,
  onClose,
  onSelectRelated,
}: {
  detail: LessonDetailView;
  onApprove: (id: string) => void;
  onRetire: (id: string) => void;
  onClose: () => void;
  onSelectRelated: (id: string) => void;
}) {
  const { lesson, related } = detail;

  return (
    <Card className="lesson-detail" role="dialog" aria-labelledby="lesson-title">
      <header className="lesson-detail-header">
        <h2 id="lesson-title">{lesson.id}: {lesson.title}</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close detail">
          ×
        </Button>
      </header>
      <div className="lesson-badges">
        <Badge tone={STATUS_TONES[lesson.status]}>
          {STATUS_LABELS[lesson.status]}
        </Badge>
        <Badge tone="info" plain>
          {SCOPE_LABELS[lesson.scope]}
        </Badge>
        <Badge tone="neutral" plain>{SIGNAL_KIND_LABELS[lesson.signal.kind] ?? lesson.signal.kind}</Badge>
      </div>
      <dl className="lesson-fields">
        <dt>Signal</dt>
        <dd>
          <code>{lesson.signal.value}</code>
          {lesson.signal.threshold !== undefined && (
            <> (threshold: {lesson.signal.threshold}, {lesson.signal.direction ?? "above"})</>
          )}
        </dd>
        <dt>Cause</dt>
        <dd>{lesson.cause}</dd>
        <dt>Response</dt>
        <dd>{lesson.response}</dd>
        <dt>Prevention</dt>
        <dd>{lesson.prevention}</dd>
        {lesson.feature && (
          <>
            <dt>Feature</dt>
            <dd>{lesson.feature}</dd>
          </>
        )}
        <dt>Matches</dt>
        <dd>{lesson.matchCount} (last: {formatDate(lesson.lastMatchAt)})</dd>
        <dt>Created</dt>
        <dd>{formatDate(lesson.createdAt)}</dd>
        <dt>Sources</dt>
        <dd>
          {lesson.sources.length > 0
            ? lesson.sources.map((s, i) => (
                <span key={i} className="source">{s.kind}: {s.ref}</span>
              ))
            : "—"}
        </dd>
      </dl>
      <div className="lesson-actions">
        {canApprove(lesson) && (
          <Button variant="primary" onClick={() => onApprove(lesson.id)}>Approve</Button>
        )}
        {canRetire(lesson) && (
          <Button variant="secondary" onClick={() => onRetire(lesson.id)}>Retire</Button>
        )}
      </div>
      {related.length > 0 && (
        <section className="related-lessons">
          <h3>Related lessons</h3>
          <ul>
            {related.map((r) => (
              <li key={r.id}>
                <Button variant="link" onClick={() => onSelectRelated(r.id)}>
                  {r.id}: {r.title}
                </Button>
                <Badge tone={STATUS_TONES[r.status]}>
                  {STATUS_LABELS[r.status]}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
}
