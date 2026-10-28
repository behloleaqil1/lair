/**
 * The reader's look: theme (system, light or dark) and density (comfortable
 * or compact). Kept in localStorage; every access is wrapped, so a browser
 * that refuses storage (private mode, blocked cookies) still works with the
 * defaults. Applied as attributes on <html>, which tokens.css reads:
 * data-theme="light|dark" (none for "system"), data-density="compact" (none
 * for comfortable).
 */
import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";

export interface Preferences {
  theme: ThemeChoice;
  density: Density;
}

export const DEFAULT_PREFERENCES: Preferences = { theme: "system", density: "comfortable" };

export const THEME_KEY = "lair.theme";
export const DENSITY_KEY = "lair.density";

/** The part of Storage this module uses (tests pass their own) */
export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): PreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Reading localStorage itself throws where storage is blocked
    return null;
  }
}

function read(storage: PreferenceStorage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** The stored choices; anything missing, unknown or unreadable is the default. */
export function loadPreferences(storage: PreferenceStorage | null = defaultStorage()): Preferences {
  const theme = read(storage, THEME_KEY);
  const density = read(storage, DENSITY_KEY);
  return {
    theme: theme === "light" || theme === "dark" || theme === "system" ? theme : DEFAULT_PREFERENCES.theme,
    density: density === "compact" || density === "comfortable" ? density : DEFAULT_PREFERENCES.density,
  };
}

/** Keep the choices; false when the browser would not store them (they still apply to this page). */
export function savePreferences(prefs: Preferences, storage: PreferenceStorage | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(THEME_KEY, prefs.theme);
    storage.setItem(DENSITY_KEY, prefs.density);
    return true;
  } catch {
    return false;
  }
}

/** Set the attributes tokens.css reads on the root element. */
export function applyPreferences(prefs: Preferences, root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement): void {
  if (!root) return;
  if (prefs.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", prefs.theme);
  if (prefs.density === "compact") root.setAttribute("data-density", "compact");
  else root.removeAttribute("data-density");
}

/** The choices, applied and kept as they change. */
export function usePreferences(): [Preferences, (next: Partial<Preferences>) => void] {
  const [prefs, setPrefs] = useState<Preferences>(() => loadPreferences());
  useEffect(() => {
    applyPreferences(prefs);
  }, [prefs]);
  const update = useCallback((next: Partial<Preferences>) => {
    setPrefs((current) => {
      const merged = { ...current, ...next };
      savePreferences(merged);
      return merged;
    });
  }, []);
  return [prefs, update];
}
