/**
 * Settings → Overview: the setup checklist (docs/design/settings-v2.md).
 * One part per thing a project sets up, each ok, attention or off (waiting
 * while its source is read) with one line and a link to where it is fixed.
 *
 * Read-only, and from what the dashboard reads anyway: the project's
 * settings and their problems, the repository check, the AI tools' state
 * (which the server reduces to fixed words: never a tool's output), the
 * machines' reachability and the notification settings. No secret is in any
 * of them, and none is shown. Without a DOM, so tests check the same rules
 * the page (components/SettingsOverview.tsx) draws.
 */
import type { AiToolsView } from "../shared/ai-types";
import type { NotificationStatusView } from "../shared/notification-types";
import type { FieldError, RepoCheck } from "../shared/settings-types";
import { isPlainObject } from "../shared/settings-rules";
import type { MachineStatus } from "../shared/types";
import { pageHref, type SettingsPage } from "./settings-pages";
import type { Status } from "./ui/tokens";

export type ChecklistPart = "repository" | "ai" | "agents" | "gates" | "machines" | "notifications" | "reviews";

export interface ChecklistItem {
  part: ChecklistPart;
  title: string;
  /** ok, attention or off; waiting while its source is read */
  status: Status;
  /** One line: what was found */
  detail: string;
  /** Where it is set */
  fix: { label: string; href: string };
}

/** A source of the checklist: still read (loading), refused or failed (error), or its answer. */
export type Source<T> = { state: "loading" } | { state: "error"; error: string } | { state: "ok"; data: T };

export interface ChecklistInput {
  /** The project the links name (null: the one selected) */
  project: string | null;
  /** The project file, parsed */
  values: Record<string, unknown>;
  /** What keeps the file from loading */
  errors: FieldError[];
  repo: Source<RepoCheck>;
  tools: Source<AiToolsView>;
  machines: Source<MachineStatus[]>;
  notifications: Source<NotificationStatusView>;
}

const TIERS = ["red", "amber", "green"] as const;
const DEFAULT_REVIEWER: Record<(typeof TIERS)[number], string> = { red: "a human", amber: "a peer", green: "a self-check" };
const MAX_DETAIL = 200;

const record = (value: unknown): Record<string, unknown> => (isPlainObject(value) ? value : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function line(detail: string): string {
  return detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 3)}...` : detail;
}

/** "a, b and c" (at most `max` names, then "and N more") */
export function nameList(names: readonly string[], max = 3): string {
  if (names.length <= 1) return names.join("");
  if (names.length > max) return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The problems (from the file's checks) in these top-level blocks, or under these dotted prefixes. */
function problemsIn(errors: FieldError[], blocks: string[], prefixes: string[] = []): FieldError[] {
  return errors.filter((e) => blocks.includes(e.path.split(".")[0]) || prefixes.some((p) => e.path.startsWith(p)));
}

function problemLine(problems: FieldError[]): string {
  const first = problems[0];
  const where = first.path ? `${first.path}: ` : "";
  return `${plural(problems.length, "problem")} keep the file from loading: ${where}${first.message}`;
}

/** Each part, in the order the page lists them. */
export function setupChecklist(input: ChecklistInput): ChecklistItem[] {
  const link = (page: SettingsPage, detail: string | null = null) => pageHref(page, detail, input.project);
  const item = (part: ChecklistPart, title: string, fix: ChecklistItem["fix"]) => (status: Status, detail: string): ChecklistItem => ({
    part,
    title,
    status,
    detail: line(detail),
    fix,
  });
  return [
    repository(input, item("repository", "Repository", { label: "Project settings", href: link("classic", "project") })),
    aiTools(input, item("ai", "AI tools signed in", { label: "AI settings", href: link("classic", "ai") })),
    agents(input, item("agents", "Agents", { label: "Agents", href: link("classic", "dragons") })),
    gates(input, item("gates", "Gates", { label: "Gate pipelines", href: link("classic", "pipelines") })),
    machines(input, item("machines", "Machines", { label: "Machines", href: link("classic", "machines") })),
    notifications(input, item("notifications", "Notifications", { label: "Notifications", href: link("classic", "notifications") })),
    reviews(input, item("reviews", "Reviews", { label: "Reviews and merge", href: link("classic", "review") })),
  ];
}

type Make = (status: Status, detail: string) => ChecklistItem;

function repository({ values, errors, repo }: ChecklistInput, make: Make): ChecklistItem {
  const problems = problemsIn(errors, ["repo", "github"]);
  if (problems.length > 0) return make("attention", problemLine(problems));
  const path = text(values.repo);
  const github = text(values.github);
  if (!path) return make("attention", "No repository path (repo)");
  if (repo.state === "loading") return make("waiting", `Checking ${path}...`);
  if (repo.state === "error") return make("attention", `Could not check ${path}: ${repo.error}`);
  const found = repo.data;
  if (!found.exists) return make("attention", `${path} doesn't exist on this machine`);
  if (!found.gitRepo) return make("attention", found.problem ?? `${path} is not a git work tree`);
  if (github && found.remotes.length > 0 && !found.remotes.some((r) => r.github === github)) {
    return make("attention", `github is ${github}, but no remote of ${path} is that repository${found.github ? ` (origin: ${found.github})` : ""}`);
  }
  if (!github && found.github) return make("attention", `github isn't set, so pull requests can't be read; the remote is ${found.github}`);
  return make("ok", github ? `${path}, on GitHub as ${github}` : `${path}, a git work tree with no GitHub repository`);
}

function aiTools({ errors, tools }: ChecklistInput, make: Make): ChecklistItem {
  const problems = problemsIn(errors, ["ai", "agent_adapters"]);
  if (problems.length > 0) return make("attention", problemLine(problems));
  if (tools.state === "loading") return make("waiting", "Checking the tools...");
  if (tools.state === "error") return make("attention", `Could not check the tools: ${tools.error}`);
  const used = tools.data.tools.filter((t) => t.inUse);
  if (used.length === 0) return make("off", "No profile or agent names a tool yet");
  const issues: string[] = [];
  for (const tool of used) {
    for (const machine of tool.machines) {
      const where = machine.machine === "local" ? "this machine" : machine.machine;
      if (machine.installed === false) issues.push(`${tool.name} is not installed on ${where}`);
      else if (machine.signIn.state === "signed_out") {
        issues.push(`${tool.name} is not signed in on ${where}${machine.signIn.fix ? `: run ${machine.signIn.fix} in a terminal there` : ""}`);
      }
    }
  }
  if (issues.length > 0) return make("attention", issues.length === 1 ? issues[0] : `${issues[0]} (and ${issues.length - 1} more)`);
  const names = used.map((t) => t.name);
  const signedIn = used.filter((t) => t.machines.length > 0 && t.machines.every((m) => m.signIn.state === "signed_in"));
  if (signedIn.length === used.length) return make("ok", `${nameList(names)}: signed in`);
  const unchecked = used.filter((t) => !signedIn.includes(t)).map((t) => t.name);
  return make("ok", `${nameList(names)}: installed; ${nameList(unchecked)} can't say whether ${unchecked.length === 1 ? "it is" : "they are"} signed in`);
}

function agents({ values, errors }: ChecklistInput, make: Make): ChecklistItem {
  const problems = problemsIn(errors, ["dragons", "dragon_defaults", "agents"]);
  if (problems.length > 0) return make("attention", problemLine(problems));
  const dragons = Object.entries(record(values.dragons));
  if (dragons.length === 0) return make("off", "No agents (dragons) in the project's file yet");
  const onProfile = dragons.filter(([, d]) => text(record(d).profile) !== "").length;
  const supervised = record(values.agents).enabled === true ? "; Lair runs them (agents.enabled)" : "";
  return make("ok", `${plural(dragons.length, "agent")}${onProfile > 0 ? `, ${onProfile} on an AI profile` : ""}${supervised}`);
}

function gates({ values, errors }: ChecklistInput, make: Make): ChecklistItem {
  const problems = problemsIn(errors, ["pipelines", "executors"]);
  if (problems.length > 0) return make("attention", problemLine(problems));
  const pipelines = Object.keys(record(values.pipelines));
  if (pipelines.length === 0) return make("off", "No gate pipelines: Gates shows the external queue in gates_dir only");
  return make("ok", `${plural(pipelines.length, "pipeline")}: ${nameList(pipelines)}`);
}

function machines({ values, errors, machines: statuses }: ChecklistInput, make: Make): ChecklistItem {
  const problems = problemsIn(errors, ["machines"]);
  if (problems.length > 0) return make("attention", problemLine(problems));
  const configured = record(values.machines);
  const known = new Set(["local", ...Object.keys(configured)]);
  for (const [id, dragon] of Object.entries(record(values.dragons))) {
    const on = text(record(dragon).machine);
    if (on && !known.has(on)) return make("attention", `${id} runs on ${on}, which is not one of the project's machines`);
  }
  const ssh = Object.entries(configured).filter(([, m]) => record(m).type === "ssh");
  const hostless = ssh.find(([, m]) => !text(record(m).host));
  if (hostless) return make("attention", `${hostless[0]} is an SSH machine with no host`);
  if (ssh.length === 0) return make("ok", "This machine only");
  const ids = ssh.map(([id]) => id);
  if (statuses.state === "loading") return make("waiting", `Checking ${nameList(ids)}...`);
  if (statuses.state === "error") return make("attention", `Could not check ${nameList(ids)}: ${statuses.error}`);
  const down = statuses.data.filter((s) => ids.includes(s.name) && !s.up).map((s) => s.name);
  if (down.length > 0) return make("attention", `${nameList(down)} ${down.length === 1 ? "doesn't" : "don't"} answer`);
  return make("ok", `This machine and ${plural(ssh.length, "SSH machine")} (${nameList(ids)})`);
}

function notifications({ notifications: source }: ChecklistInput, make: Make): ChecklistItem {
  if (source.state === "loading") return make("waiting", "Reading the notification settings...");
  if (source.state === "error") return make("attention", `Could not read the notification settings: ${source.error}`);
  const { settings, errors, desktopAvailable } = source.data;
  if (errors.length > 0) return make("attention", `data/server.yaml was refused, so notifications are off: ${errors[0]}`);
  if (!settings.enabled) return make("off", "Off: what needs you shows in the dashboard only");
  if (settings.desktop && !settings.ntfyUrl && !desktopAvailable.ok) {
    return make("attention", `Desktop notifications can't be shown on this machine: ${desktopAvailable.detail}`);
  }
  const channels = [settings.desktop ? "desktop" : "", settings.ntfyUrl ? "phone (ntfy)" : ""].filter(Boolean);
  return make("ok", `On: ${nameList(channels)}`);
}

function reviews({ values, errors }: ChecklistInput, make: Make): ChecklistItem {
  const problems = problemsIn(errors, ["review"], ["ai.roles.review"]);
  if (problems.length > 0) return make("attention", problemLine(problems));
  const review = record(values.review);
  if (review.enabled !== true) return make("off", "Reviews and policy merge are off");
  const roles = record(record(record(values.ai).roles).review);
  const reviewers = record(review.reviewers);
  const pools = record(review.reviewers_pool);
  const role = (tier: string) => (Array.isArray(roles[tier]) ? (roles[tier] as unknown[]).filter((p): p is string => typeof p === "string") : []);
  if (text(review.prompt_file) && TIERS.every((t) => role(t).length === 0 && pools[t] === undefined)) {
    return make("attention", "Reviews by agents are on (review.prompt_file), but no tier names reviewer agents: give a tier a reviewer role");
  }
  const who = (tier: (typeof TIERS)[number]) => {
    const first = role(tier)[0];
    if (first) return first;
    if (reviewers[tier] !== undefined) return "as review.reviewers sets";
    return `${DEFAULT_REVIEWER[tier]} (default)`;
  };
  return make("ok", TIERS.map((t) => `${t.toUpperCase()}: ${who(t)}`).join("; "));
}
