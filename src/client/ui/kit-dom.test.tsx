// @vitest-environment jsdom
/**
 * The kit's keyboard paths in a DOM: Dialog and Drawer take the focus, keep
 * Tab inside, close on Esc (the top layer only) and give the focus back;
 * Tabs move with the arrow keys; the Combobox opens, moves and picks from
 * the keyboard; Switch toggles; Table sorts from its header; Toasts close by
 * themselves; Tooltips open on focus and close on Esc.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dialog } from "./Dialog";
import { Drawer } from "./Drawer";
import { Tabs } from "./Tabs";
import { Combobox } from "./Combobox";
import { Switch } from "./Switch";
import { Table } from "./Table";
import { ToastProvider, useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { trapTarget } from "./focus";

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

function render(node: ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

function key(target: Element | Document, k: string, shift = false) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
  });
}

function click(el: Element) {
  act(() => {
    (el as HTMLElement).click();
  });
}

function Opener({ layer }: { layer: "dialog" | "drawer" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" id="opener" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && layer === "dialog" && (
        <Dialog title="Confirm the merge" onClose={() => setOpen(false)} footer={<button type="button">Merge</button>}>
          <input aria-label="Note" />
        </Dialog>
      )}
      {open && layer === "drawer" && (
        <Drawer title="kiro-A" onClose={() => setOpen(false)}>
          <a href="#/work">Back</a>
          <button type="button">Release</button>
        </Drawer>
      )}
    </>
  );
}

describe("Dialog", () => {
  it("is a named modal dialog that takes the focus, traps Tab, closes on Esc and gives the focus back", () => {
    const el = render(<Opener layer="dialog" />);
    const opener = el.querySelector<HTMLButtonElement>("#opener")!;
    opener.focus();
    click(opener);
    const dialog = el.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const titleId = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(titleId)?.textContent).toBe("Confirm the merge");
    expect(document.activeElement).toBe(dialog);

    // Tab from the last focusable wraps to the first, Shift+Tab from the first to the last
    const focusables = [...dialog.querySelectorAll<HTMLElement>("button, input")];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    last.focus();
    key(last, "Tab");
    expect(document.activeElement).toBe(first);
    key(first, "Tab", true);
    expect(document.activeElement).toBe(last);

    key(document.activeElement!, "Escape");
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes from its close button and the scrim", () => {
    const el = render(<Opener layer="dialog" />);
    click(el.querySelector("#opener")!);
    click(el.querySelector('[aria-label="Close"]')!);
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    click(el.querySelector("#opener")!);
    click(el.querySelector(".scrim")!);
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("Drawer", () => {
  it("is a modal side panel: focus in, Esc out, focus back", () => {
    const el = render(<Opener layer="drawer" />);
    const opener = el.querySelector<HTMLButtonElement>("#opener")!;
    opener.focus();
    click(opener);
    const drawer = el.querySelector<HTMLElement>(".drawer")!;
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(document.activeElement).toBe(drawer);
    key(drawer, "Escape");
    expect(el.querySelector(".drawer")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("Esc closes only the top layer: a dialog over a drawer closes first", () => {
    function Stack() {
      const [drawer, setDrawer] = useState(true);
      const [dialog, setDialog] = useState(true);
      return (
        <>
          {drawer && (
            <Drawer title="Detail" onClose={() => setDrawer(false)}>
              <button type="button">x</button>
            </Drawer>
          )}
          {dialog && (
            <Dialog title="Sure?" onClose={() => setDialog(false)}>
              <button type="button">y</button>
            </Dialog>
          )}
        </>
      );
    }
    const el = render(<Stack />);
    key(document.activeElement ?? document, "Escape");
    expect(el.querySelector(".dialog")).toBeNull();
    expect(el.querySelector(".drawer")).not.toBeNull();
    key(document.activeElement ?? document, "Escape");
    expect(el.querySelector(".drawer")).toBeNull();
  });
});

describe("trapTarget", () => {
  it("sends the focus in from outside, and wraps at both ends", () => {
    const box = document.createElement("div");
    box.innerHTML = '<button id="a">a</button><button id="b" disabled>b</button><button id="c">c</button>';
    document.body.appendChild(box);
    const a = box.querySelector("#a")!;
    const c = box.querySelector("#c")!;
    expect(trapTarget(box, document.body, false)).toBe(a);
    expect(trapTarget(box, document.body, true)).toBe(c);
    expect(trapTarget(box, c, false)).toBe(a);
    expect(trapTarget(box, a, true)).toBe(c);
    expect(trapTarget(box, a, false)).toBeNull();
    box.remove();
  });
});

describe("Tabs", () => {
  it("moves the selection and the focus with the arrow keys", () => {
    function Host() {
      const [selected, setSelected] = useState("a");
      return (
        <Tabs
          label="Views"
          selected={selected}
          onSelect={setSelected}
          tabs={[
            { id: "a", label: "A", panel: "panel a" },
            { id: "b", label: "B", panel: "panel b" },
            { id: "c", label: "C", panel: "panel c" },
          ]}
        />
      );
    }
    const el = render(<Host />);
    const tabs = () => [...el.querySelectorAll<HTMLElement>('[role="tab"]')];
    tabs()[0].focus();
    key(tabs()[0], "ArrowRight");
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs()[1]);
    expect(el.querySelector('[role="tabpanel"]')?.textContent).toBe("panel b");
    key(tabs()[1], "End");
    expect(tabs()[2].getAttribute("aria-selected")).toBe("true");
    key(tabs()[2], "ArrowRight");
    expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
  });
});

describe("Combobox", () => {
  function Host({ allowCustom = true, onPick }: { allowCustom?: boolean; onPick?: (v: string) => void }) {
    const [value, setValue] = useState("");
    return (
      <Combobox
        aria-label="Profile"
        options={["claude-opus", "claude-sonnet", "kiro"]}
        value={value}
        allowCustom={allowCustom}
        onChange={(v: string) => {
          setValue(v);
          onPick?.(v);
        }}
      />
    );
  }

  it("opens with ArrowDown, moves the highlight, picks with Enter and closes on Esc", () => {
    const picked: string[] = [];
    const el = render(<Host onPick={(v) => picked.push(v)} />);
    const input = el.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => input.focus());
    key(input, "ArrowDown");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const active = () => input.getAttribute("aria-activedescendant");
    expect(document.getElementById(active()!)?.textContent).toBe("claude-opus");
    key(input, "ArrowDown");
    expect(document.getElementById(active()!)?.textContent).toBe("claude-sonnet");
    key(input, "Enter");
    expect(picked).toEqual(["claude-sonnet"]);
    expect(input.value).toBe("claude-sonnet");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    key(input, "ArrowDown");
    key(input, "Escape");
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("filters as you type, and picks with a click", () => {
    const picked: string[] = [];
    const el = render(<Host allowCustom={false} onPick={(v) => picked.push(v)} />);
    const input = el.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => input.focus());
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "kir");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const options = [...el.querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.textContent)).toEqual(["kiro"]);
    expect(picked).toEqual([]);
    click(options[0]);
    expect(picked).toEqual(["kiro"]);
  });
});

describe("Switch", () => {
  it("toggles aria-checked on click", () => {
    function Host() {
      const [on, setOn] = useState(false);
      return <Switch label="Compact" checked={on} onChange={setOn} />;
    }
    const el = render(<Host />);
    const sw = el.querySelector('[role="switch"]')!;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });
});

describe("Table", () => {
  it("sorts by a header click and flips on the second, saying so in aria-sort", () => {
    const el = render(
      <Table
        label="Agents"
        rows={[
          { id: "a", n: 2 },
          { id: "b", n: 10 },
          { id: "c", n: 1 },
        ]}
        rowKey={(r) => r.id}
        empty="none"
        columns={[{ key: "n", label: "Runs", render: (r) => String(r.n), sort: (r) => r.n }]}
      />,
    );
    const cells = () => [...el.querySelectorAll("tbody td")].map((td) => td.textContent);
    const th = el.querySelector("th")!;
    expect(cells()).toEqual(["2", "10", "1"]);
    click(th.querySelector("button")!);
    expect(th.getAttribute("aria-sort")).toBe("ascending");
    expect(cells()).toEqual(["1", "2", "10"]);
    click(th.querySelector("button")!);
    expect(th.getAttribute("aria-sort")).toBe("descending");
    expect(cells()).toEqual(["10", "2", "1"]);
  });

  it("opens a row with Enter and moves between rows with the arrows", () => {
    const opened: string[] = [];
    const el = render(
      <Table
        label="Agents"
        rows={[{ id: "a" }, { id: "b" }]}
        rowKey={(r) => r.id}
        onOpen={(r) => opened.push(r.id)}
        empty="none"
        columns={[{ key: "id", label: "Id", render: (r) => r.id }]}
      />,
    );
    const rows = [...el.querySelectorAll<HTMLElement>("tbody tr")];
    rows[0].focus();
    key(rows[0], "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
    key(rows[1], "Enter");
    expect(opened).toEqual(["b"]);
  });
});

describe("Toast", () => {
  it("shows a note in a live region and closes it by itself", () => {
    vi.useFakeTimers();
    let show: ReturnType<typeof useToast>["show"] = () => -1;
    function Grab() {
      show = useToast().show;
      return null;
    }
    const el = render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
    act(() => {
      show("Saved", { tone: "success", timeout: 1000 });
      show("Could not save", { tone: "danger", timeout: 0 });
    });
    expect(el.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe("Notifications");
    expect(el.querySelector('[role="status"]')?.textContent).toContain("Saved");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(el.querySelector('[role="status"]')).toBeNull();
    click(el.querySelector('[aria-label="Dismiss"]')!);
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("Tooltip", () => {
  it("opens while its trigger has the focus and closes on Esc", () => {
    const el = render(
      <Tooltip content="Restarts the server">
        <button type="button">Restart</button>
      </Tooltip>,
    );
    const button = el.querySelector("button")!;
    const tip = el.querySelector('[role="tooltip"]')!;
    expect(button.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.classList.contains("open")).toBe(false);
    act(() => button.focus());
    expect(tip.classList.contains("open")).toBe(true);
    key(button, "Escape");
    expect(tip.classList.contains("open")).toBe(false);
  });
});
