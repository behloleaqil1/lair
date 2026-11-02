/**
 * A budget scope's lines (the agents module's per-agent and per-project
 * budgets): what was used this period against the soft and hard limits.
 * A request or minute line whose guard isn't in act (budgets.guard_mode
 * observe or off) holds nothing at its hard limit, and says so.
 */
import type { BudgetLine, BudgetScopeView } from "../../shared/agents-types";
import { Badge } from "./ui";

/** A hard limit reached that holds nothing: its guard only watches (observe) or is off */
const watchedOnly = (line: BudgetLine) => line.level === "hard" && line.guard !== undefined && line.guard !== "act";

export function BudgetLines({ budget }: { budget: BudgetScopeView | null }) {
  if (!budget || budget.lines.length === 0) return <span className="muted small">No limits set</span>;
  return (
    <ul className="muted small m-0">
      {budget.lines.map((line) => (
        <li key={line.metric}>
          <Badge tone={line.level === "hard" && !watchedOnly(line) ? "error" : line.level !== "ok" ? "warning" : "neutral"}>
            {watchedOnly(line) ? `hard (${line.guard}: nothing held)` : line.level}
          </Badge>{" "}
          {line.metric.replace(/_/g, " ")} {line.period}: {line.used}
          {line.soft !== undefined && ` / soft ${line.soft}`}
          {line.hard !== undefined && ` / hard ${line.hard}`}
        </li>
      ))}
    </ul>
  );
}
