/**
 * The Settings forms, drawn from each section's JSON Schema
 * (settings-form.ts decides the fields and widgets): a card per section with
 * its enable switch, defaults as placeholders, advanced fields folded,
 * commands marked, errors under their field, and keys no schema knows shown
 * read-only. Edits go up as (path, value) pairs; undefined removes a key.
 */
import { useEffect, useState } from "react";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { FieldError, KnownValues, PathSegment, SettingsSection } from "../../shared/settings-types";
import { isPlainObject } from "../../shared/settings-rules";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import {
  defaultLabel,
  entryFields,
  errorsAt,
  fieldsOf,
  listToText,
  sectionEnabled,
  sectionFields,
  textToList,
  textToNumber,
  type FieldContext,
  type FieldModel,
} from "../settings-form";

type OnChange = (path: PathSegment[], value: unknown) => void;

interface Shared {
  ctx: FieldContext;
  errors: FieldError[];
  disabled: boolean;
  showAdvanced: boolean;
  onChange: OnChange;
}

/**
 * Text the field shows, kept locally while typed, so a half-typed value
 * ("1.", a new line, YAML in progress) isn't reformatted under the cursor.
 * When the value changes from outside (reset, reload) to something the text
 * doesn't mean, the text follows it.
 */
function useLocalText(
  value: unknown,
  format: (v: unknown) => string,
  parse: (t: string) => unknown,
): [string, (t: string) => void] {
  const formatted = format(value);
  const [text, setText] = useState(formatted);
  useEffect(() => {
    let mine: string | null;
    try {
      mine = format(parse(text));
    } catch {
      mine = null;
    }
    if (mine !== formatted) setText(formatted);
    // Only when the value changes: typing changes `text`, not this
  }, [formatted]);
  return [text, setText];
}

function yamlText(value: unknown): string {
  if (value === undefined) return "";
  return stringifyYaml(value, { lineWidth: 0 }).replace(/\n$/, "");
}

function parseYamlText(text: string): unknown {
  return text.trim() === "" ? undefined : (parseYaml(text) as unknown);
}

const numberText = (v: unknown) => (v === undefined ? "" : String(v));

function ErrorLines({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <div className="error small mt-1" data-field-error="">
      {messages.map((m, i) => (
        <div key={i}>{m}</div>
      ))}
    </div>
  );
}

function ListEditor({ field, disabled, onChange }: { field: FieldModel; disabled: boolean; onChange: OnChange }) {
  const [text, setText] = useLocalText(field.value, listToText, textToList);
  const lines = Math.min(12, Math.max(2, text.split("\n").length + 1));
  return (
    <textarea
      className="input textarea mono"
      rows={lines}
      value={text}
      disabled={disabled}
      placeholder={
        field.kind === "argv" ? `one argument per line (no shell)${defaultLabel(field) ? `; ${defaultLabel(field)}` : ""}` : defaultLabel(field) || "one per line"
      }
      onChange={(e) => {
        setText(e.target.value);
        onChange(field.path, textToList(e.target.value));
      }}
    />
  );
}

function NumberEditor({ field, disabled, onChange }: { field: FieldModel; disabled: boolean; onChange: OnChange }) {
  const [text, setText] = useLocalText(field.value, numberText, textToNumber);
  return (
    <input
      className="input" style={{ maxWidth: "12rem" }}
      inputMode="decimal"
      value={text}
      disabled={disabled}
      placeholder={defaultLabel(field)}
      onChange={(e) => {
        setText(e.target.value);
        onChange(field.path, textToNumber(e.target.value));
      }}
    />
  );
}

function YamlEditor({ field, disabled, onChange }: { field: FieldModel; disabled: boolean; onChange: OnChange }) {
  const [text, setText] = useLocalText(field.value, yamlText, parseYamlText);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <textarea
        className="input textarea mono"
        rows={Math.min(14, Math.max(2, text.split("\n").length + 1))}
        value={text}
        disabled={disabled || field.readOnly}
        readOnly={field.readOnly}
        placeholder={defaultLabel(field) || "YAML"}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === "") {
            setProblem(null);
            onChange(field.path, undefined);
            return;
          }
          try {
            const value = parseYaml(e.target.value) as unknown;
            setProblem(null);
            onChange(field.path, value === null ? null : value);
          } catch (error) {
            setProblem(error instanceof Error ? error.message.split("\n")[0] : String(error));
          }
        }}
      />
      {problem && <ErrorLines messages={[`YAML: ${problem}`]} />}
    </>
  );
}

function Leaf({ field, disabled, onChange }: { field: FieldModel; disabled: boolean; onChange: OnChange }) {
  const listId = field.options ? `opts-${field.path.join("-")}` : undefined;
  switch (field.kind) {
    case "toggle": {
      const checked = typeof field.value === "boolean" ? field.value : field.defaultValue === true;
      return (
        <label className="muted small">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(e) => onChange(field.path, e.target.checked)}
          />{" "}
          {field.value === undefined ? "(default)" : ""}
        </label>
      );
    }
    case "number":
      return <NumberEditor field={field} disabled={disabled} onChange={onChange} />;
    case "select": {
      const values = (field.schema.enum ?? (field.schema.const !== undefined ? [field.schema.const] : [])) as unknown[];
      return (
        <select
          className="input" style={{ maxWidth: "20rem" }}
          value={field.value === undefined ? "" : String(field.value)}
          disabled={disabled}
          onChange={(e) => {
            const picked = values.find((v) => String(v) === e.target.value);
            onChange(field.path, e.target.value === "" ? undefined : picked);
          }}
        >
          <option value="">{defaultLabel(field) ? `(${defaultLabel(field)})` : "(not set)"}</option>
          {values.map((v) => (
            <option key={String(v)} value={String(v)}>
              {String(v)}
            </option>
          ))}
        </select>
      );
    }
    case "argv":
    case "list":
    case "globs":
      return (
        <>
          <ListEditor field={field} disabled={disabled} onChange={onChange} />
          {field.options && field.options.length > 0 && <p className="muted small">Known: {field.options.join(", ")}</p>}
        </>
      );
    case "textarea":
      return (
        <textarea
          className="input textarea"
          rows={4}
          value={typeof field.value === "string" ? field.value : ""}
          disabled={disabled}
          placeholder={defaultLabel(field)}
          onChange={(e) => onChange(field.path, e.target.value === "" ? undefined : e.target.value)}
        />
      );
    case "text":
    case "path":
      return (
        <>
          <input
            className={field.kind === "path" ? "input mono" : "input"}
            list={listId}
            value={typeof field.value === "string" ? field.value : field.value === undefined ? "" : String(field.value)}
            disabled={disabled}
            placeholder={defaultLabel(field) || (field.kind === "path" ? "a path" : "")}
            onChange={(e) => onChange(field.path, e.target.value === "" ? undefined : e.target.value)}
          />
          {listId && (
            <datalist id={listId}>
              {field.options!.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          )}
        </>
      );
    default:
      return <YamlEditor field={field} disabled={disabled} onChange={onChange} />;
  }
}

function Collection({ field, shared }: { field: FieldModel; shared: Shared }) {
  const [adding, setAdding] = useState("");
  const { ctx, disabled, onChange } = shared;
  if (field.kind === "object") {
    const pattern = field.pattern === "" ? [] : field.pattern.split(".");
    return <FieldList fields={fieldsOf(field.schema, field.value, field.path, pattern, ctx)} shared={shared} />;
  }
  const entrySchema = field.kind === "record" ? field.schema.additionalProperties : field.schema.items;
  const blank = typeof entrySchema === "object" && entrySchema.type === "object" ? {} : "";
  if (field.kind === "record") {
    const entries = isPlainObject(field.value) ? Object.entries(field.value) : [];
    return (
      <div>
        {entries.map(([key, value]) => (
          <div key={key} className="nested">
            <div className="row">
              <code>{key}</code>
              <Button size="sm" disabled={disabled} onClick={() => onChange([...field.path, key], undefined)}>
                Remove
              </Button>
            </div>
            <FieldList fields={entryFields(field, key, value, ctx)} shared={shared} />
          </div>
        ))}
        <div className="row mt-1">
          <input
            className="input" style={{ maxWidth: "14rem" }}
            value={adding}
            disabled={disabled}
            placeholder={`new ${field.key} entry`}
            onChange={(e) => setAdding(e.target.value.trim())}
          />
          <Button
            size="sm"
            disabled={disabled || adding === "" || entries.some(([k]) => k === adding)}
            onClick={() => {
              onChange([...field.path, adding], blank);
              setAdding("");
            }}
          >
            Add
          </Button>
        </div>
      </div>
    );
  }
  const items = Array.isArray(field.value) ? field.value : [];
  return (
    <div>
      {items.map((item, i) => (
        <div key={i} className="nested">
          <div className="row">
            <span className="muted small">#{i + 1}</span>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() =>
                onChange(
                  field.path,
                  items.filter((_, j) => j !== i),
                )
              }
            >
              Remove
            </Button>
          </div>
          <FieldList fields={entryFields(field, i, item, ctx)} shared={shared} />
        </div>
      ))}
      <Button size="sm" disabled={disabled} onClick={() => onChange(field.path, [...items, blank])}>
        Add
      </Button>
    </div>
  );
}

function FieldRow({ field, shared }: { field: FieldModel; shared: Shared }) {
  const { here, inside } = errorsAt(shared.errors, field.path);
  const collection = field.kind === "object" || field.kind === "record" || field.kind === "objects";
  const [open, setOpen] = useState(field.value !== undefined || inside > 0);
  return (
    <div data-field={field.path.join(".")} className="stack-sm">
      <div className="row">
        {collection ? (
          <Button size="sm" variant="link" onClick={() => setOpen(!open)}>
            {open ? "▾" : "▸"} <code>{field.key}</code>
          </Button>
        ) : (
          <code>{field.key}</code>
        )}
        {field.required && <span className="text-warning">required</span>}
        {field.command && <Badge tone="warning">runs a command</Badge>}
        {field.sensitive && !field.command && (
          <span className="badge badge-warning" title="It decides what Lair runs or where it sends code and tokens">
            confirmed on save
          </span>
        )}
        {field.readOnly && <Badge tone="neutral">read-only: edit in the YAML tab</Badge>}
        {inside > 0 && <Badge tone="error">{inside} error(s) inside</Badge>}
        {field.value !== undefined && !field.required && !field.readOnly && (
          <Button size="sm" variant="ghost"
            disabled={shared.disabled}
            title="Remove the key: its default applies"
            onClick={() => shared.onChange(field.path, undefined)}
          >
            reset
          </Button>
        )}
      </div>
      {field.help && <div className="muted small">{field.help}</div>}
      <div className="spaced-xs">
        {collection ? (
          open && <Collection field={field} shared={shared} />
        ) : (
          <Leaf field={field} disabled={shared.disabled} onChange={shared.onChange} />
        )}
      </div>
      <ErrorLines messages={here} />
    </div>
  );
}

function FieldList({ fields, shared }: { fields: FieldModel[]; shared: Shared }) {
  const shown = fields.filter(
    (f) => !f.advanced || shared.showAdvanced || f.value !== undefined || errorsAt(shared.errors, f.path).here.length > 0,
  );
  const hidden = fields.length - shown.length;
  return (
    <div className="pl-1">
      {shown.map((field) => (
        <FieldRow key={field.path.join("\0")} field={field} shared={shared} />
      ))}
      {hidden > 0 && <div className="muted small">{hidden} advanced field(s) hidden</div>}
    </div>
  );
}

interface SectionProps {
  section: SettingsSection;
  draft: Record<string, unknown>;
  known: KnownValues | null;
  errors: FieldError[];
  disabled: boolean;
  onChange: OnChange;
}

function SectionCard({ section, draft, known, errors, disabled, onChange }: SectionProps) {
  const count = errors.filter((e) => section.blocks.includes(e.path.split(".")[0])).length;
  const [open, setOpen] = useState(count > 0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const configured = section.blocks.some((b) => draft[b] !== undefined);
  const fields = sectionFields(section, draft, known).filter(
    (f) => !(section.toggle && f.path.length === 2 && f.key === "enabled"),
  );
  const shared: Shared = { ctx: { section, known }, errors, disabled, showAdvanced, onChange };
  return (
    <div className="card section-intro" data-settings-section={section.key}>
      <div className="row row-lg">
        <Button variant="link" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} {section.title}
        </Button>
        {section.toggle && (
          <label className="muted small">
            <input
              type="checkbox"
              checked={sectionEnabled(section, draft)}
              disabled={disabled}
              onChange={(e) => onChange([section.key, "enabled"], e.target.checked)}
            />{" "}
            enabled
          </label>
        )}
        {!configured && <Badge tone="neutral">not set: defaults</Badge>}
        {count > 0 && <Badge tone="error">{count} error(s)</Badge>}
        {section.docs && <span className="muted small">{section.docs}</span>}
      </div>
      {open && (
        <div className="spaced-sm">
          <label className="muted small">
            <input type="checkbox" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} /> Show
            advanced
          </label>
          <FieldList fields={fields} shared={shared} />
        </div>
      )}
    </div>
  );
}

export interface SettingsFormProps {
  sections: SettingsSection[];
  draft: Record<string, unknown>;
  known: KnownValues | null;
  errors: FieldError[];
  unknownKeys: string[];
  disabled: boolean;
  onChange: OnChange;
}

export function SettingsForm({ sections, draft, known, errors, unknownKeys, disabled, onChange }: SettingsFormProps) {
  return (
    <div data-settings-form="">
      {sections.map((section) => (
        <SectionCard
          key={section.key}
          section={section}
          draft={draft}
          known={known}
          errors={errors}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
      {unknownKeys.length > 0 && (
        <div className="card section-intro" data-settings-section="unknown">
          <h3>Other keys</h3>
          <p className="muted small">No section knows these keys. Settings keeps them as they are; edit them in the YAML tab.</p>
          {unknownKeys.map((key) => (
            <div key={key} className="stack-sm">
              <code>{key}</code>
              <pre className="code-block">{yamlText(draft[key])}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
