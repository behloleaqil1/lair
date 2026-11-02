/**
 * Budget lines as Work and an agent's detail render them: a request or minute
 * line over its hard limit holds new runs only with budgets.guard_mode act
 * (AI spend G5); in observe or off it says it holds nothing.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BudgetLines } from "./Budget";
import type { BudgetLine, BudgetScopeView } from "../../shared/agents-types";

const scope = (lines: BudgetLine[]): BudgetScopeView => ({ scope: "project", lines, blocked: false });
const render = (lines: BudgetLine[]) => renderToStaticMarkup(createElement(BudgetLines, { budget: scope(lines) }));
const requests = (guard: BudgetLine["guard"]): BudgetLine => ({ metric: "daily_requests", period: "2026-03-02", used: 61, soft: 50, hard: 60, level: "hard", guard });

describe("BudgetLines", () => {
  it("a request line over its hard limit in observe or off says it holds nothing; in act it is a hard limit", () => {
    const observe = render([requests("observe")]);
    expect(observe).toContain("hard (observe: nothing held)");
    expect(observe).toContain('data-tone="warning"');
    expect(render([requests("off")])).toContain("hard (off: nothing held)");
    const act = render([requests("act")]);
    expect(act).not.toContain("nothing held");
    expect(act).toContain(">hard<");
    expect(act).toContain('data-tone="danger"');
    expect(act).toContain("daily requests 2026-03-02: 61 / soft 50 / hard 60");
  });

  it("a cost line over its hard limit is a hard limit, as before", () => {
    const html = render([{ metric: "daily_cost", period: "2026-03-02", used: 9, hard: 8, level: "hard" }]);
    expect(html).toContain(">hard<");
    expect(html).not.toContain("nothing held");
  });
});
