/**
 * The dashboard's views and their nav labels (App.tsx renders them).
 */
export type View =
  | "decisions"
  | "overview"
  | "dragons"
  | "gates"
  | "prs"
  | "orchestrator"
  | "machines"
  | "nodes"
  | "processes"
  | "activity"
  | "health"
  | "delivery"
  | "reviews"
  | "agents"
  | "triage"
  | "inbox";

/**
 * The owner's message file (inbox_file: instructions to the orchestrator and
 * its replies) is "Owner messages", so it isn't taken for Decisions, where
 * Lair asks the owner. Its view id stays "inbox".
 */
export const OWNER_MESSAGES_LABEL = "Owner messages";

/** Under the Owner messages heading */
export const OWNER_MESSAGES_SUBTITLE =
  "Instructions you send the orchestrator and its replies (inbox_file). Decisions Lair needs from you are in Decisions.";

export const VIEWS: { id: View; label: string }[] = [
  { id: "overview", label: "Overview" },
  // The Decision Inbox: the one place Lair asks you; its badge counts open decisions
  { id: "decisions", label: "Decisions" },
  { id: "dragons", label: "Dragons" },
  { id: "nodes", label: "Nodes" },
  { id: "gates", label: "Gates" },
  { id: "prs", label: "PRs" },
  { id: "reviews", label: "Reviews" },
  { id: "orchestrator", label: "Orchestrator" },
  { id: "machines", label: "Machines" },
  { id: "processes", label: "Processes" },
  { id: "activity", label: "Activity" },
  { id: "health", label: "Health" },
  { id: "delivery", label: "Delivery" },
  { id: "agents", label: "Agents" },
  { id: "triage", label: "Triage" },
  { id: "inbox", label: OWNER_MESSAGES_LABEL },
];
