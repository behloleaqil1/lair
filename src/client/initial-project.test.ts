import { describe, it, expect } from "vitest";
import { pickInitialProject } from "./initial-project";

describe("pickInitialProject", () => {
  it("opens the server's default project when it is listed", () => {
    expect(pickInitialProject(["example", "mine"], "mine")).toBe("mine");
  });

  it("ignores a server default that is not listed", () => {
    expect(pickInitialProject(["example", "mine"], "gone")).toBe("example");
  });

  it("falls back to example, then to the first project", () => {
    expect(pickInitialProject(["a", "example"])).toBe("example");
    expect(pickInitialProject(["b", "a"])).toBe("b");
    expect(pickInitialProject(["b", "a"], null)).toBe("b");
    expect(pickInitialProject(["b", "a"], 42)).toBe("b");
  });

  it("returns undefined when there are no projects", () => {
    expect(pickInitialProject([], "mine")).toBeUndefined();
  });
});
