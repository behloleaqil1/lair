/**
 * The kit's markup, rendered to static HTML: names, roles and the aria
 * attributes that make each component accessible, and the rules apart from
 * the components (combobox matching, tab keys, tones).
 */
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge, StatusBadge } from "./Badge";
import { Button, ButtonLink } from "./Button";
import { Callout } from "./Card";
import { CodeBlock } from "./CodeBlock";
import { Combobox } from "./Combobox";
import { EmptyState } from "./EmptyState";
import { Field, Input } from "./Field";
import { Breadcrumbs, PageHeader } from "./PageHeader";
import { Select } from "./Select";
import { Skeleton } from "./Skeleton";
import { Switch } from "./Switch";
import { Table } from "./Table";
import { TabLinks, Tabs, tabKeyTarget } from "./Tabs";
import { Tooltip } from "./Tooltip";
import { filterOptions, moveHighlight, toOptions } from "./combobox-utils";
import { STATUS, space, toneOf } from "./tokens";

const html = (node: ReactElement) => renderToStaticMarkup(node);
const noop = () => undefined;

describe("Button", () => {
  it("is a type=button with the label as its own text, type and disabled first", () => {
    const out = html(
      <Button disabled onClick={noop}>
        Start it again
      </Button>,
    );
    expect(out).toMatch(/^<button type="button" disabled="" class="btn btn-secondary btn-md">Start it again<\/button>$/);
  });

  it("takes a variant, a size and a decorative icon", () => {
    const out = html(
      <Button variant="primary" size="sm" icon="check-circle" type="submit">
        Save
      </Button>,
    );
    expect(out).toContain('type="submit"');
    expect(out).toContain('class="btn btn-primary btn-sm"');
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain(">Save</button>");
  });

  it("ButtonLink is a link, not a button", () => {
    const out = html(<ButtonLink href="#/decisions">Answer in Decisions</ButtonLink>);
    expect(out).toBe('<a class="btn btn-secondary btn-md" href="#/decisions">Answer in Decisions</a>');
  });
});

describe("Field", () => {
  it("labels its control and points it at its help and error", () => {
    const out = html(
      <Field label="Max active" help="Runs fill starts at once" error="Must be 1 or more">
        <Input id="max-active" />
      </Field>,
    );
    expect(out).toContain('<label for="max-active"');
    expect(out).toContain('id="max-active"');
    expect(out).toContain('aria-describedby="max-active-help max-active-error"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('<p id="max-active-help" class="field-help">Runs fill starts at once</p>');
    expect(out).toContain('role="alert">Must be 1 or more</p>');
  });

  it("gives the control an id when it has none, and is valid without an error", () => {
    const out = html(
      <Field label="Theme">
        <Select options={[{ value: "system", label: "System" }]} value="system" onChange={noop} />
      </Field>,
    );
    const id = /<label for="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`id="${id}"`);
    expect(out).toContain("<select");
    expect(out).not.toContain("aria-invalid");
  });
});

describe("Badge and StatusBadge", () => {
  it("pairs every status colour with an icon and a word", () => {
    for (const status of Object.keys(STATUS) as (keyof typeof STATUS)[]) {
      const out = html(<StatusBadge status={status} />);
      expect(out).toContain("<svg");
      expect(out).toContain(`>${STATUS[status].word}</span>`);
      expect(out).toContain(`data-status="${status}"`);
    }
  });

  it("reads the view models' badge classes, keeping the class name", () => {
    expect(html(<Badge tone="badge-error">hung</Badge>)).toContain('class="badge badge-error"');
    expect(html(<Badge tone="badge-success">Running</Badge>)).toContain('data-tone="success"');
    expect(html(<Badge tone="warning">held</Badge>)).toContain("<svg");
    expect(html(<Badge plain>main</Badge>)).not.toContain("<svg");
  });

  it("maps tones", () => {
    expect(toneOf("badge-error")).toBe("danger");
    expect(toneOf("failing")).toBe("danger");
    expect(toneOf("badge-warning")).toBe("warning");
    expect(toneOf("waiting")).toBe("info");
    expect(toneOf("badge-neutral")).toBe("neutral");
    expect(toneOf("anything")).toBe("neutral");
    expect(space(4)).toBe("var(--space-4)");
  });
});

describe("Switch", () => {
  it("is a switch with its state and its label", () => {
    const out = html(<Switch label="Compact" checked onChange={noop} />);
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="true"');
    const labelId = /aria-labelledby="([^"]+)"/.exec(out)?.[1];
    expect(out).toContain(`id="${labelId}"`);
    expect(out).toContain(">Compact</span>");
  });
});

describe("Tabs", () => {
  it("TabLinks are links, the current one aria-current", () => {
    const out = html(
      <TabLinks
        label="Gates tabs"
        active="results"
        tabs={[
          { id: null, label: "Queue", href: "#/gates" },
          { id: "results", label: "Results", href: "#/gates?tab=results" },
        ]}
      />,
    );
    expect(out).toContain('<nav class="tabs" aria-label="Gates tabs">');
    expect(out).toContain('<a href="#/gates?tab=results" class="tab active" aria-current="page">Results</a>');
  });

  it("in-page Tabs: a tablist, the selected tab in the tab order and naming its panel", () => {
    const out = html(
      <Tabs
        label="Views"
        selected="b"
        onSelect={noop}
        tabs={[
          { id: "a", label: "A", panel: "panel a" },
          { id: "b", label: "B", panel: "panel b" },
        ]}
      />,
    );
    expect(out).toContain('role="tablist" aria-label="Views"');
    expect(out.match(/role="tab"/g)).toHaveLength(2);
    expect(out).toContain('aria-selected="true" aria-controls=');
    expect(out).toContain('aria-selected="false" tabindex="-1"');
    expect(out).toContain('role="tabpanel"');
    expect(out).toContain("panel b");
    expect(out).not.toContain("panel a");
  });

  it("moves with the arrow keys, Home and End, wrapping around", () => {
    expect(tabKeyTarget(0, "ArrowRight", 3)).toBe(1);
    expect(tabKeyTarget(2, "ArrowRight", 3)).toBe(0);
    expect(tabKeyTarget(0, "ArrowLeft", 3)).toBe(2);
    expect(tabKeyTarget(1, "Home", 3)).toBe(0);
    expect(tabKeyTarget(1, "End", 3)).toBe(2);
    expect(tabKeyTarget(1, "a", 3)).toBeNull();
  });
});

describe("Combobox", () => {
  it("is a combobox controlling a listbox, closed at first", () => {
    const out = html(<Combobox aria-label="Profile" options={["claude", "kiro"]} value="kiro" onChange={noop} />);
    expect(out).toContain('role="combobox"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('aria-autocomplete="list"');
    const list = /aria-controls="([^"]+)"/.exec(out)?.[1];
    expect(out).toContain(`id="${list}" role="listbox"`);
    expect(out).toContain('value="kiro"');
  });

  it("matches what is typed in labels and values, prefix matches first", () => {
    const options = toOptions(["opus", { value: "kiro-1", label: "Kiro one" }, "sonnet-opus"]);
    expect(filterOptions(options, "").map((o) => o.value)).toEqual(["opus", "kiro-1", "sonnet-opus"]);
    expect(filterOptions(options, "OPUS").map((o) => o.value)).toEqual(["opus", "sonnet-opus"]);
    expect(filterOptions(options, "one").map((o) => o.value)).toEqual(["kiro-1"]);
    expect(filterOptions(options, "kiro-").map((o) => o.value)).toEqual(["kiro-1"]);
  });

  it("moves the highlight with the arrows, wrapping", () => {
    expect(moveHighlight(-1, "ArrowDown", 3)).toBe(0);
    expect(moveHighlight(2, "ArrowDown", 3)).toBe(0);
    expect(moveHighlight(0, "ArrowUp", 3)).toBe(2);
    expect(moveHighlight(-1, "ArrowUp", 3)).toBe(2);
    expect(moveHighlight(0, "ArrowDown", 0)).toBe(-1);
    expect(moveHighlight(0, "Enter", 3)).toBeNull();
  });
});

describe("Table", () => {
  const rows = [
    { id: "a", name: "kiro-A", runs: 2 },
    { id: "b", name: "kiro-B", runs: 10 },
  ];
  it("has column headers, says the sort order, and marks the open row aria-current", () => {
    const out = html(
      <Table
        label="Agents"
        rows={rows}
        rowKey={(r) => r.id}
        onOpen={noop}
        selected="b"
        empty="none"
        initialSort={{ key: "runs", dir: "desc" }}
        columns={[
          { key: "name", label: "Name", render: (r) => r.name, sort: (r) => r.name },
          { key: "runs", label: "Runs", render: (r) => r.runs, sort: (r) => r.runs, align: "right" },
        ]}
      />,
    );
    expect(out).toContain('<table class="table" aria-label="Agents">');
    expect(out).toContain('scope="col" aria-sort="none"');
    expect(out).toContain('scope="col" aria-sort="descending" class="align-right"');
    expect(out.indexOf("kiro-B")).toBeLessThan(out.indexOf("kiro-A"));
    expect(out).toContain('class="clickable selected" tabindex="0" aria-current="true"');
    expect(out).not.toContain("aria-selected");
  });

  it("shows its empty state without rows", () => {
    expect(html(<Table label="Agents" rows={[]} rowKey={() => ""} columns={[]} empty={<p>No agents yet</p>} />)).toBe(
      '<div class="table-empty"><p>No agents yet</p></div>',
    );
  });
});

describe("the rest of the kit", () => {
  it("Breadcrumbs: links back, the current page last", () => {
    const out = html(<Breadcrumbs items={[{ label: "Work", href: "#/work" }, { label: "kiro-A" }]} />);
    expect(out).toContain('<nav class="breadcrumbs" aria-label="Breadcrumb">');
    expect(out).toContain('<a href="#/work">Work</a>');
    expect(out).toContain('<span aria-current="page">kiro-A</span>');
  });

  it("PageHeader: the title, its status and actions", () => {
    const out = html(<PageHeader title="Gates" status={<StatusBadge status="ok" />} actions={<Button>Run</Button>} />);
    expect(out).toContain('<h2 class="page-title">Gates</h2>');
    expect(out).toContain('data-status="ok"');
    expect(out).toContain('<div class="page-header-actions">');
  });

  it("Callout: an alert only when asked, with the tone's icon", () => {
    expect(html(<Callout tone="danger" alert>Down</Callout>)).toContain('role="alert"');
    expect(html(<Callout tone="info">Note</Callout>)).not.toContain("role=");
    expect(html(<Callout tone="warning">Careful</Callout>)).toContain("<svg");
  });

  it("CodeBlock: focusable so it scrolls from the keyboard, a named region with a label", () => {
    const out = html(<CodeBlock label="Gate log">line 1</CodeBlock>);
    expect(out).toContain('tabindex="0" role="region" aria-label="Gate log"');
    expect(html(<CodeBlock>x</CodeBlock>)).not.toContain("role=");
  });

  it("EmptyState: the title, why, and the one action", () => {
    const out = html(<EmptyState title="No machines yet" action={<Button>Add a machine</Button>}>Machines run gates.</EmptyState>);
    expect(out).toContain("<h3>No machines yet</h3>");
    expect(out).toContain("Machines run gates.");
    expect(out).toContain(">Add a machine</button>");
  });

  it("Skeleton is hidden from screen readers", () => {
    expect(html(<Skeleton />)).toContain('aria-hidden="true"');
  });

  it("Tooltip: the hint describes its trigger", () => {
    const out = html(
      <Tooltip content="Restarts the server">
        <Button>Restart</Button>
      </Tooltip>,
    );
    const id = /aria-describedby="([^"]+)"/.exec(out)?.[1];
    expect(out).toContain(`id="${id}" role="tooltip"`);
    expect(out).toContain("Restarts the server");
  });
});
