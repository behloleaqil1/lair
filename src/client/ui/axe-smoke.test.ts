// @vitest-environment jsdom
/**
 * Temporary: axe-core runs in this project's vitest under jsdom (replaced by
 * the per-view check in a11y.test.tsx).
 */
import { describe, expect, it } from "vitest";
import axe from "axe-core";

describe("axe under jsdom", () => {
  it("finds an unlabelled input and passes a labelled one", async () => {
    document.body.innerHTML = '<main><h1>Smoke</h1><input type="text"><label>Name <input type="text"></label></main>';
    const result = await axe.run(document.body, { resultTypes: ["violations"] });
    const label = result.violations.find((v) => v.id === "label");
    expect(label?.nodes).toHaveLength(1);
  });
});
