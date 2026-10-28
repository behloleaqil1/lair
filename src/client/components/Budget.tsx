/**
 * A budget scope's lines (the agents module's per-agent and per-project
 * budgets): what was used this period against the soft and hard limits.
 */
import type { BudgetScopeView } from "../../shared/agents-types";
import { Badge } from "./ui";

export function BudgetLines({ budget }: { budget: BudgetScopeView | null }) {
  if (!budget || budget.lines.length === 0) return <span className="muted small">No limits set</span>;
  return (
    <ul className="muted small m-0">
      {budget.lines.map((line) => (
        <li key={line.metric}>
          <Badge tone={line.level === "hard" ? "error" : line.level === "soft" ? "warning" : "neutral"}>{line.level}</Badge>{" "}
          {line.metric.replace(/_/g, " ")} {line.period}: {line.used}
          {line.soft !== undefined && ` / soft ${line.soft}`}
          {line.hard !== undefined && ` / hard ${line.hard}`}
        </li>
      ))}
    </ul>
  );
}
