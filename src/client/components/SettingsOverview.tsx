/**
 * Settings → Overview: the setup checklist (setup-checklist.ts), one part
 * per row with its status, one line and a link to where it is fixed.
 * Read-only: it reads the repository check, the AI tools' state, the
 * machines and the notification settings once (and again after a save), and
 * changes nothing.
 */
import { useEffect, useMemo, useState } from "react";
import type { AiToolsView } from "../../shared/ai-types";
import type { NotificationStatusView } from "../../shared/notification-types";
import type { ProjectSettingsView, RepoCheck } from "../../shared/settings-types";
import type { MachineStatus } from "../../shared/types";
import { loadAiTools } from "../ai-api";
import { loadNotifications } from "../notifications-api";
import { checkRepository, ownerCall } from "../settings-api";
import { setupChecklist, type Source } from "../setup-checklist";
import { StatusBadge } from "../ui/Badge";
import { Card } from "../ui/Card";

interface Reply<T> {
  success: boolean;
  data?: T;
  error?: string;
}

function sourceOf<T>(reply: Reply<T>, what: string): Source<T> {
  return reply.success && reply.data !== undefined ? { state: "ok", data: reply.data } : { state: "error", error: reply.error ?? `no ${what}` };
}

const LOADING = { state: "loading" } as const;

export function SettingsOverview({ view, project }: { view: ProjectSettingsView; project: string | null }) {
  const [repo, setRepo] = useState<Source<RepoCheck>>(LOADING);
  const [tools, setTools] = useState<Source<AiToolsView>>(LOADING);
  const [machines, setMachines] = useState<Source<MachineStatus[]>>(LOADING);
  const [notifications, setNotifications] = useState<Source<NotificationStatusView>>(LOADING);
  const repoPath = typeof view.values?.repo === "string" ? view.values.repo : "";

  // Once per version of the file: the checks run commands, so not on every refresh
  useEffect(() => {
    let cancelled = false;
    const keep =
      <T,>(set: (s: Source<T>) => void, what: string) =>
      (reply: Reply<T>) => {
        if (!cancelled) set(sourceOf(reply, what));
      };
    setRepo(LOADING);
    setTools(LOADING);
    setMachines(LOADING);
    setNotifications(LOADING);
    if (repoPath) void checkRepository(repoPath).then(keep<RepoCheck>(setRepo, "repository check"));
    void loadAiTools(view.id).then(keep<AiToolsView>(setTools, "tools"));
    void ownerCall<MachineStatus[]>("GET", `/api/machines?project=${encodeURIComponent(view.id)}`).then(
      keep<MachineStatus[]>(setMachines, "machines"),
    );
    void loadNotifications().then((reply) => {
      if (!cancelled) setNotifications(sourceOf({ success: reply.ok, data: reply.data, error: reply.error }, "notification settings"));
    });
    return () => {
      cancelled = true;
    };
  }, [view.id, view.hash, repoPath]);

  const items = useMemo(
    () =>
      setupChecklist({
        project,
        values: view.values ?? {},
        errors: view.errors,
        repo,
        tools,
        machines,
        notifications,
      }),
    [project, view, repo, tools, machines, notifications],
  );
  const ok = items.filter((i) => i.status === "ok").length;
  const attention = items.filter((i) => i.status === "attention").length;

  return (
    <Card title="Setup checklist" data-settings-overview="">
      <p className="muted small mb-3" aria-live="polite">
        {ok} of {items.length} parts ok
        {attention > 0 ? `; ${attention} ${attention === 1 ? "needs" : "need"} you` : ""}
      </p>
      <ul className="checklist" aria-label="Setup checklist">
        {items.map((item) => (
          <li key={item.part} className="checklist-item" data-part={item.part} data-status={item.status}>
            <StatusBadge status={item.status} />
            <div className="checklist-text">
              <strong>{item.title}</strong>
              <span className="checklist-detail">{item.detail}</span>
            </div>
            <a href={item.fix.href} className="checklist-fix">
              {item.fix.label}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
