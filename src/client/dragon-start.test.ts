import { describe, it, expect } from "vitest";
import { canStartDragon, dragonSummary, hasStartableDragons } from "./dragon-start";
import type { DragonConfig } from "../shared/types";

const yamlDragon: DragonConfig = {
  id: "kiro-A",
  name: "Smaug",
  model: "claude-opus-4.5",
  machine: "local",
  instructions: "",
};
// As the server returns a dragon listed only in dragons.txt
const txtDragon: DragonConfig = {
  id: "kiro-B",
  name: "Fafnir",
  model: "",
  machine: "",
  instructions: "",
};

describe("hasStartableDragons", () => {
  it("is true when the server lists any dragon, from either source", () => {
    expect(hasStartableDragons({ "kiro-A": yamlDragon })).toBe(true);
    expect(hasStartableDragons({ "kiro-B": txtDragon })).toBe(true);
  });

  it("is false for no dragons or no config yet", () => {
    expect(hasStartableDragons({})).toBe(false);
    expect(hasStartableDragons(undefined)).toBe(false);
  });
});

describe("canStartDragon", () => {
  const startable = { "kiro-A": yamlDragon, "kiro-B": txtDragon };

  it("allows dragons the server lists", () => {
    expect(canStartDragon("kiro-A", startable)).toBe(true);
    expect(canStartDragon("kiro-B", startable)).toBe(true);
  });

  it("refuses dragons the server does not list", () => {
    expect(canStartDragon("1-agent", startable)).toBe(false);
    expect(canStartDragon("toString", startable)).toBe(false);
    expect(canStartDragon("kiro-A", undefined)).toBe(false);
  });
});

describe("dragonSummary", () => {
  it("shows a YAML dragon's machine and model", () => {
    expect(dragonSummary(yamlDragon)).toBe("Machine: local | Model: claude-opus-4.5");
  });

  it("shows placeholders for a dragons.txt-only dragon", () => {
    expect(dragonSummary(txtDragon)).toBe("Machine: - | Model: not set");
  });
});
