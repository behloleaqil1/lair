/**
 * A text field with a list of suggestions (the WAI-ARIA editable combobox
 * with list autocomplete). Typing filters the list; ArrowDown and ArrowUp
 * move the highlight (ArrowDown opens it), Enter picks the highlighted
 * option, Esc closes the list (and, closed, gives the text back to the
 * value). With `allowCustom` (the default), what is typed is the value too;
 * without it, only an option can be picked.
 */
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { filterOptions, moveHighlight, toOptions, type ComboOption } from "./combobox";

export interface ComboboxProps {
  options: readonly (string | ComboOption)[];
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  allowCustom?: boolean;
  /** What is shown when nothing matches */
  emptyText?: string;
  "aria-label"?: string;
  /** The name of the suggestion list (default "Suggestions") */
  listLabel?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  id,
  placeholder,
  disabled,
  allowCustom = true,
  emptyText = "No matches",
  listLabel = "Suggestions",
  className,
  ...aria
}: ComboboxProps) {
  const auto = useId();
  const inputId = id ?? `combobox-${auto}`;
  const listId = `${inputId}-list`;
  const all = useMemo(() => toOptions(options), [options]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // What is typed while the list is open; null shows the value
  const [query, setQuery] = useState<string | null>(null);
  const labelOf = (v: string) => all.find((o) => o.value === v)?.label ?? v;
  const text = query ?? labelOf(value);
  const shown = filterOptions(all, query ?? "");
  const optionId = (i: number) => `${listId}-${i}`;

  const choose = (option: ComboOption) => {
    onChange(option.value);
    setQuery(null);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(event.key === "ArrowDown" ? 0 : shown.length - 1);
        return;
      }
      const next = moveHighlight(active, event.key, shown.length);
      if (next !== null) setActive(next);
      return;
    }
    if (event.key === "Enter" && open && active >= 0 && shown[active]) {
      event.preventDefault();
      choose(shown[active]);
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setActive(-1);
      } else if (query !== null) {
        event.preventDefault();
        setQuery(null);
      }
    }
  };

  const listShown = open && shown.length > 0;
  return (
    <div className={`combobox${className ? ` ${className}` : ""}`}>
      <input
        id={inputId}
        type="text"
        className="input"
        role="combobox"
        aria-expanded={listShown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={listShown && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        placeholder={placeholder}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(-1);
          if (allowCustom) onChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
          if (!allowCustom) setQuery(null);
        }}
        {...aria}
      />
      <ul id={listId} role="listbox" className="combobox-list" hidden={!listShown} aria-label={listLabel}>
        {shown.map((option, i) => (
          <li
            key={option.value}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            className={`combobox-option${i === active ? " active" : ""}${option.value === value ? " current" : ""}`}
            // Keep the focus in the input; the click picks the option
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(option)}
          >
            {option.label}
          </li>
        ))}
      </ul>
      {open && shown.length === 0 && (
        <div className="combobox-empty" role="status">
          {emptyText}
        </div>
      )}
    </div>
  );
}
