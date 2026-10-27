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

const muted = { color: "var(--text-secondary)", fontSize: "0.85rem" };
export const inputStyle = {
  padding: "0.35rem",
  borderRadius: "4px",
  border: "1px solid var(--border)",
  background: "var(--bg-secondary)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  width: "100%",
};
const mono = { ...inputStyle, fontFamily: "monospace", fontSize: "0.85rem" };
export const smallButton = {
  padding: "0.2rem 0.5rem",
  borderRadius: "4px",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-primary)",
  cursor: "pointer",
  fontSize: "0.8rem",
};
const linkButton = { ...smallButton, border: "none", padding: 0, fontSize: "1rem", fontWeight: 600 };

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
    <div className="error" data-field-error="" style={{ fontSize: "0.8rem", marginTop: "0.2rem" }}>
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
      style={mono}
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
      style={{ ...inputStyle, maxWidth: "12rem" }}
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
        style={mono}
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
        <label style={muted}>
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
          style={{ ...inputStyle, maxWidth: "20rem" }}
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
          {field.options && field.options.length > 0 && <p style={muted}>Known: {field.options.join(", ")}</p>}
        </>
      );
    case "textarea":
      return (
        <textarea
          style={inputStyle}
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
            style={field.kind === "path" ? mono : inputStyle}
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
          <div key={key} style={{ borderLeft: "2px solid var(--border)", paddingLeft: "0.75rem", margin: "0.5rem 0" }}>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <code>{key}</code>
              <button style={smallButton} disabled={disabled} onClick={() => onChange([...field.path, key], undefined)}>
                Remove
              </button>
            </div>
            <FieldList fields={entryFields(field, key, value, ctx)} shared={shared} />
          </div>
        ))}
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
          <input
            style={{ ...inputStyle, maxWidth: "14rem" }}
            value={adding}
            disabled={disabled}
            placeholder={`new ${field.key} entry`}
            onChange={(e) => setAdding(e.target.value.trim())}
          />
          <button
            style={smallButton}
            disabled={disabled || adding === "" || entries.some(([k]) => k === adding)}
            onClick={() => {
              onChange([...field.path, adding], blank);
              setAdding("");
            }}
          >
            Add
          </button>
        </div>
      </div>
    );
  }
  const items = Array.isArray(field.value) ? field.value : [];
  return (
    <div>
      {items.map((item, i) => (
        <div key={i} style={{ borderLeft: "2px solid var(--border)", paddingLeft: "0.75rem", margin: "0.5rem 0" }}>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <span style={muted}>#{i + 1}</span>
            <button
              style={smallButton}
              disabled={disabled}
              onClick={() =>
                onChange(
                  field.path,
                  items.filter((_, j) => j !== i),
                )
              }
            >
              Remove
            </button>
          </div>
          <FieldList fields={entryFields(field, i, item, ctx)} shared={shared} />
        </div>
      ))}
      <button style={smallButton} disabled={disabled} onClick={() => onChange(field.path, [...items, blank])}>
        Add
      </button>
    </div>
  );
}

function FieldRow({ field, shared }: { field: FieldModel; shared: Shared }) {
  const { here, inside } = errorsAt(shared.errors, field.path);
  const collection = field.kind === "object" || field.kind === "record" || field.kind === "objects";
  const [open, setOpen] = useState(field.value !== undefined || inside > 0);
  return (
    <div data-field={field.path.join(".")} style={{ margin: "0.6rem 0" }}>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", flexWrap: "wrap" }}>
        {collection ? (
          <button style={{ ...linkButton, fontSize: "0.9rem" }} onClick={() => setOpen(!open)}>
            {open ? "▾" : "▸"} <code>{field.key}</code>
          </button>
        ) : (
          <code>{field.key}</code>
        )}
        {field.required && <span style={{ color: "var(--warning)" }}>required</span>}
        {field.command && <span className="badge badge-warning">runs a command</span>}
        {field.readOnly && <span className="badge badge-neutral">read-only: edit in the YAML tab</span>}
        {inside > 0 && <span className="badge badge-error">{inside} error(s) inside</span>}
        {field.value !== undefined && !field.required && !field.readOnly && (
          <button
            style={{ ...smallButton, border: "none", color: "var(--text-secondary)" }}
            disabled={shared.disabled}
            title="Remove the key: its default applies"
            onClick={() => shared.onChange(field.path, undefined)}
          >
            reset
          </button>
        )}
      </div>
      {field.help && <div style={muted}>{field.help}</div>}
      <div style={{ marginTop: "0.2rem" }}>
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
    <div style={{ paddingLeft: "0.25rem" }}>
      {shown.map((field) => (
        <FieldRow key={field.path.join("\0")} field={field} shared={shared} />
      ))}
      {hidden > 0 && <div style={muted}>{hidden} advanced field(s) hidden</div>}
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
    <div className="card" data-settings-section={section.key} style={{ marginBottom: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
        <button style={linkButton} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} {section.title}
        </button>
        {section.toggle && (
          <label style={muted}>
            <input
              type="checkbox"
              checked={sectionEnabled(section, draft)}
              disabled={disabled}
              onChange={(e) => onChange([section.key, "enabled"], e.target.checked)}
            />{" "}
            enabled
          </label>
        )}
        {!configured && <span className="badge badge-neutral">not set: defaults</span>}
        {count > 0 && <span className="badge badge-error">{count} error(s)</span>}
        {section.docs && <span style={muted}>{section.docs}</span>}
      </div>
      {open && (
        <div style={{ marginTop: "0.5rem" }}>
          <label style={muted}>
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
        <div className="card" data-settings-section="unknown" style={{ marginBottom: "1rem" }}>
          <h3 style={{ fontSize: "1rem" }}>Other keys</h3>
          <p style={muted}>No section knows these keys. Settings keeps them as they are; edit them in the YAML tab.</p>
          {unknownKeys.map((key) => (
            <div key={key} style={{ margin: "0.5rem 0" }}>
              <code>{key}</code>
              <pre style={{ ...mono, whiteSpace: "pre-wrap" }}>{yamlText(draft[key])}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
