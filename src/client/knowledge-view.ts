/**
 * The Knowledge view: lists lessons grouped or filterable by signal kind,
 * with status and scope badges, and detail view with related lessons.
 *
 * Owner-only: signs in as the owner (the lessons API is requireOwner).
 */
import { html, type TemplateResult } from "lit-html";
import type { LessonsListView, LessonSummary, LessonDetailView, LessonStatus } from "../shared/lessons-types";
import { listLessons, getLesson, approveLesson, retireLesson, STATUS_LABELS, STATUS_COLORS, groupBySignalKind, SIGNAL_KIND_LABELS } from "./lessons-api";
import type { Route } from "./router";

export interface KnowledgeViewState {
  loading: boolean;
  error: string | null;
  view: LessonsListView | null;
  filter: {
    status: LessonStatus | "all";
    scope: "built-in" | "project" | "all";
  };
  detail: LessonDetailView | null;
  detailId: string | null;
}

export function initialKnowledgeState(): KnowledgeViewState {
  return {
    loading: true,
    error: null,
    view: null,
    filter: { status: "all", scope: "all" },
    detail: null,
    detailId: null,
  };
}

export async function loadKnowledge(
  project: string,
  state: KnowledgeViewState,
  setState: (s: KnowledgeViewState) => void,
): Promise<void> {
  setState({ ...state, loading: true, error: null });
  try {
    const filter = {
      status: state.filter.status === "all" ? undefined : state.filter.status,
      scope: state.filter.scope === "all" ? undefined : state.filter.scope,
    };
    const view = await listLessons(project, filter);
    setState({ ...state, loading: false, view, error: null });
  } catch (e) {
    setState({ ...state, loading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function loadLessonDetail(
  id: string,
  state: KnowledgeViewState,
  setState: (s: KnowledgeViewState) => void,
): Promise<void> {
  setState({ ...state, detailId: id, detail: null });
  try {
    const detail = await getLesson(id);
    setState({ ...state, detailId: id, detail });
  } catch (e) {
    setState({ ...state, detailId: id, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleApprove(
  id: string,
  project: string,
  state: KnowledgeViewState,
  setState: (s: KnowledgeViewState) => void,
): Promise<void> {
  try {
    await approveLesson(id);
    await loadKnowledge(project, state, setState);
    if (state.detailId === id) {
      await loadLessonDetail(id, state, setState);
    }
  } catch (e) {
    setState({ ...state, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleRetire(
  id: string,
  project: string,
  state: KnowledgeViewState,
  setState: (s: KnowledgeViewState) => void,
): Promise<void> {
  try {
    await retireLesson(id);
    await loadKnowledge(project, state, setState);
    if (state.detailId === id) {
      await loadLessonDetail(id, state, setState);
    }
  } catch (e) {
    setState({ ...state, error: e instanceof Error ? e.message : String(e) });
  }
}

function statusBadge(status: LessonStatus): TemplateResult {
  const color = STATUS_COLORS[status];
  const label = STATUS_LABELS[status];
  return html`<span class="badge badge-${color}" role="status">${label}</span>`;
}

function scopeBadge(scope: "built-in" | "project"): TemplateResult {
  const label = scope === "built-in" ? "Built-in" : "Project";
  const color = scope === "built-in" ? "blue" : "purple";
  return html`<span class="badge badge-${color}">${label}</span>`;
}

function signalKindBadge(kind: string): TemplateResult {
  const label = SIGNAL_KIND_LABELS[kind] ?? kind;
  return html`<span class="badge badge-outline">${label}</span>`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function renderLessonRow(
  lesson: LessonSummary,
  onSelect: (id: string) => void,
): TemplateResult {
  return html`
    <tr
      class="lesson-row"
      tabindex="0"
      role="button"
      aria-label="View ${lesson.title}"
      @click=${() => onSelect(lesson.id)}
      @keydown=${(e: KeyboardEvent) => e.key === "Enter" && onSelect(lesson.id)}
    >
      <td class="lesson-id">${lesson.id}</td>
      <td class="lesson-title">${lesson.title}</td>
      <td class="lesson-signal">${signalKindBadge(lesson.signal.kind)} ${lesson.signal.value}</td>
      <td class="lesson-status">${statusBadge(lesson.status)}</td>
      <td class="lesson-scope">${scopeBadge(lesson.scope)}</td>
      <td class="lesson-matches">${lesson.matchCount}</td>
      <td class="lesson-last-match">${formatDate(lesson.lastMatchAt)}</td>
    </tr>
  `;
}

export function renderLessonDetail(
  detail: LessonDetailView,
  onApprove: (id: string) => void,
  onRetire: (id: string) => void,
  onClose: () => void,
  onSelectRelated: (id: string) => void,
): TemplateResult {
  const { lesson, related } = detail;
  return html`
    <div class="lesson-detail" role="dialog" aria-labelledby="lesson-title">
      <header class="lesson-detail-header">
        <h2 id="lesson-title">${lesson.id}: ${lesson.title}</h2>
        <button class="close-btn" @click=${onClose} aria-label="Close detail">×</button>
      </header>
      <div class="lesson-badges">
        ${statusBadge(lesson.status)}
        ${scopeBadge(lesson.scope)}
        ${signalKindBadge(lesson.signal.kind)}
      </div>
      <dl class="lesson-fields">
        <dt>Signal</dt>
        <dd><code>${lesson.signal.value}</code>
          ${lesson.signal.threshold !== undefined ? html` (threshold: ${lesson.signal.threshold}, ${lesson.signal.direction ?? "above"})` : ""}
        </dd>
        <dt>Cause</dt>
        <dd>${lesson.cause}</dd>
        <dt>Response</dt>
        <dd>${lesson.response}</dd>
        <dt>Prevention</dt>
        <dd>${lesson.prevention}</dd>
        ${lesson.feature ? html`<dt>Feature</dt><dd>${lesson.feature}</dd>` : ""}
        <dt>Matches</dt>
        <dd>${lesson.matchCount} (last: ${formatDate(lesson.lastMatchAt)})</dd>
        <dt>Created</dt>
        <dd>${formatDate(lesson.createdAt)}</dd>
        <dt>Sources</dt>
        <dd>${lesson.sources.map((s) => html`<span class="source">${s.kind}: ${s.ref}</span>`).join(", ") || "—"}</dd>
      </dl>
      <div class="lesson-actions">
        ${lesson.status === "proposed" ? html`
          <button class="btn btn-primary" @click=${() => onApprove(lesson.id)}>Approve</button>
        ` : ""}
        ${lesson.status !== "retired" ? html`
          <button class="btn btn-secondary" @click=${() => onRetire(lesson.id)}>Retire</button>
        ` : ""}
      </div>
      ${related.length > 0 ? html`
        <section class="related-lessons">
          <h3>Related lessons</h3>
          <ul>
            ${related.map((r) => html`
              <li>
                <button class="link-btn" @click=${() => onSelectRelated(r.id)}>
                  ${r.id}: ${r.title}
                </button>
                ${statusBadge(r.status)}
              </li>
            `)}
          </ul>
        </section>
      ` : ""}
    </div>
  `;
}

export function renderKnowledgeView(
  state: KnowledgeViewState,
  project: string,
  route: Route,
  onNavigate: (route: Route) => void,
  setState: (s: KnowledgeViewState) => void,
): TemplateResult {
  const onFilterChange = (key: "status" | "scope", value: string) => {
    const filter = { ...state.filter, [key]: value };
    const newState = { ...state, filter };
    setState(newState);
    void loadKnowledge(project, newState, setState);
  };

  const onSelectLesson = (id: string) => {
    onNavigate({ ...route, detail: id });
    void loadLessonDetail(id, state, setState);
  };

  const onCloseDetail = () => {
    setState({ ...state, detail: null, detailId: null });
    onNavigate({ ...route, detail: null });
  };

  const onApprove = (id: string) => void handleApprove(id, project, state, setState);
  const onRetire = (id: string) => void handleRetire(id, project, state, setState);

  if (state.loading && !state.view) {
    return html`<div class="knowledge-view"><p>Loading lessons...</p></div>`;
  }

  if (state.error && !state.view) {
    return html`<div class="knowledge-view"><p class="error">Error: ${state.error}</p></div>`;
  }

  const view = state.view!;
  const lessons = view.lessons;

  // Group by signal kind for the grouped display
  const grouped = groupBySignalKind(lessons);

  return html`
    <div class="knowledge-view">
      <header class="knowledge-header">
        <h1>Knowledge</h1>
        <p class="knowledge-summary">
          ${view.counts.total} lessons: ${view.counts.active} active, ${view.counts.proposed} proposed, ${view.counts.retired} retired.
          ${view.counts.builtIn} built-in, ${view.counts.project} project.
        </p>
      </header>

      <div class="knowledge-filters" role="group" aria-label="Filter lessons">
        <label>
          Status:
          <select @change=${(e: Event) => onFilterChange("status", (e.target as HTMLSelectElement).value)}>
            <option value="all" ?selected=${state.filter.status === "all"}>All</option>
            <option value="active" ?selected=${state.filter.status === "active"}>Active</option>
            <option value="proposed" ?selected=${state.filter.status === "proposed"}>Proposed</option>
            <option value="retired" ?selected=${state.filter.status === "retired"}>Retired</option>
          </select>
        </label>
        <label>
          Scope:
          <select @change=${(e: Event) => onFilterChange("scope", (e.target as HTMLSelectElement).value)}>
            <option value="all" ?selected=${state.filter.scope === "all"}>All</option>
            <option value="built-in" ?selected=${state.filter.scope === "built-in"}>Built-in</option>
            <option value="project" ?selected=${state.filter.scope === "project"}>Project</option>
          </select>
        </label>
      </div>

      ${state.detail && state.detailId ? renderLessonDetail(
        state.detail,
        onApprove,
        onRetire,
        onCloseDetail,
        onSelectLesson,
      ) : ""}

      <div class="knowledge-content">
        ${Array.from(grouped.entries()).map(([kind, kindLessons]) => html`
          <section class="signal-kind-group">
            <h2>${SIGNAL_KIND_LABELS[kind] ?? kind}</h2>
            <table class="lessons-table" role="grid" aria-label="${SIGNAL_KIND_LABELS[kind] ?? kind} lessons">
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
                ${kindLessons.map((l) => renderLessonRow(l as LessonSummary, onSelectLesson))}
              </tbody>
            </table>
          </section>
        `)}
      </div>
    </div>
  `;
}
