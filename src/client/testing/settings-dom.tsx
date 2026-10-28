/**
 * Driving Settings in a DOM, for tests: mounted as App.tsx mounts it (its
 * route is the URL's hash, and `go` sets the hash), then waited for, typed
 * into, picked from and clicked as the owner would.
 */
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect } from "vitest";
import { Settings } from "../components/Settings";
import { parseRoute, routeHash } from "../router";

function Page({ project }: { project: string }) {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return (
    <Settings
      project={project}
      refreshKey={0}
      route={route}
      go={(next) => {
        window.location.hash = routeHash(next);
      }}
    />
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Render Settings for `project` at `hash` (#/settings...). */
export async function mountSettings(hash: string, project = "shop"): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "", `/${hash}`);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Page project={project} />));
  await settle();
  return host;
}

export function unmountSettings(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

/** Let the requests answer and the effects run. */
export async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Wait for a condition the page reaches after its requests answer (a git or a tool's check among them). */
export async function until(what: string, done: () => boolean, rounds = 400): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  if (!done()) throw new Error(`timed out waiting for ${what}\n${document.body.textContent?.slice(0, 2000)}`);
}

export async function goTo(hash: string): Promise<void> {
  act(() => {
    window.location.hash = hash;
  });
  await settle();
}

export function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Pick an option of a native select, as the browser does. */
export function choose(select: HTMLSelectElement | null | undefined, value: string): void {
  expect(select, "the select").toBeTruthy();
  expect([...select!.options].map((o) => o.value), `the options of ${select!.getAttribute("aria-label") ?? "the select"}`).toContain(value);
  act(() => {
    select!.value = value;
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export function click(el: Element | null | undefined): void {
  expect(el, "the element to click").toBeTruthy();
  act(() => {
    (el as HTMLElement).click();
  });
}

export function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

/** A button by its text (its visually hidden words included). */
export const button = (within: ParentNode, text: string): HTMLButtonElement | undefined =>
  [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
/** The drawer (or dialog) open now */
export const drawer = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');
export const saveBar = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-settings-savebar]");
