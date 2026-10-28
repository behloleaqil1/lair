/**
 * A detail view's breadcrumbs: section, tab (not the first), the row; links
 * back keep the project.
 */
import { describe, expect, it } from "vitest";
import { detailCrumbs } from "./crumbs";
import { parseRoute } from "./router";

describe("detail breadcrumbs", () => {
  it("is the section and the row on a section's first tab", () => {
    expect(detailCrumbs(parseRoute("#/work/kiro-A"), "kiro-A")).toEqual([
      { label: "Work", href: "#/work" },
      { label: "kiro-A" },
    ]);
  });

  it("names the tab when the row is on another tab, each crumb linking back without the detail", () => {
    expect(detailCrumbs(parseRoute("#/gates/g-1?tab=triage&project=demo"), "Gate g-1")).toEqual([
      { label: "Gates", href: "#/gates?project=demo" },
      { label: "Triage", href: "#/gates?tab=triage&project=demo" },
      { label: "Gate g-1" },
    ]);
  });
});
