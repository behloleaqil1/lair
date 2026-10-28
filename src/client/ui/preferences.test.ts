// @vitest-environment jsdom
/**
 * Theme and density: stored when the browser lets us, the defaults when it
 * doesn't (storage missing, or throwing on every call), and applied as the
 * attributes tokens.css reads.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  DENSITY_KEY,
  THEME_KEY,
  applyPreferences,
  loadPreferences,
  savePreferences,
  type PreferenceStorage,
} from "./preferences";

function memory(initial: Record<string, string> = {}): PreferenceStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const throwing: PreferenceStorage = {
  getItem: () => {
    throw new Error("SecurityError: storage is blocked");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("preferences", () => {
  it("defaults to the system theme and the comfortable density", () => {
    expect(loadPreferences(memory())).toEqual({ theme: "system", density: "comfortable" });
    expect(DEFAULT_PREFERENCES).toEqual({ theme: "system", density: "comfortable" });
  });

  it("keeps the choices and reads them back", () => {
    const storage = memory();
    expect(savePreferences({ theme: "dark", density: "compact" }, storage)).toBe(true);
    expect(storage.data).toEqual({ [THEME_KEY]: "dark", [DENSITY_KEY]: "compact" });
    expect(loadPreferences(storage)).toEqual({ theme: "dark", density: "compact" });
  });

  it("ignores values it doesn't know", () => {
    expect(loadPreferences(memory({ [THEME_KEY]: "neon", [DENSITY_KEY]: "tiny" }))).toEqual(DEFAULT_PREFERENCES);
  });

  it("works without storage: no storage at all, or storage that throws", () => {
    expect(loadPreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(savePreferences({ theme: "light", density: "compact" }, null)).toBe(false);
    expect(loadPreferences(throwing)).toEqual(DEFAULT_PREFERENCES);
    expect(savePreferences({ theme: "light", density: "compact" }, throwing)).toBe(false);
  });

  it("sets data-theme for light and dark, none for system; data-density only for compact", () => {
    const root = document.createElement("html");
    applyPreferences({ theme: "dark", density: "compact" }, root);
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.getAttribute("data-density")).toBe("compact");
    applyPreferences({ theme: "light", density: "comfortable" }, root);
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(root.hasAttribute("data-density")).toBe(false);
    applyPreferences({ theme: "system", density: "comfortable" }, root);
    expect(root.hasAttribute("data-theme")).toBe(false);
  });
});
