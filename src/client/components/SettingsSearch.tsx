/**
 * The Settings search box. ⌘K (Ctrl+K elsewhere) inside Settings focuses it;
 * typing lists the fields whose label, help text or YAML key match
 * (settings-search.ts), at every level; the arrow keys move through the
 * list, Enter or a click opens the field on its page, and Esc closes the
 * list (and, closed, clears the box). The WAI-ARIA editable combobox, like
 * the kit's Combobox, with search hits as its options.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { searchSettings, type SearchEntry } from "../settings-search";
import { moveHighlight } from "../ui/combobox";
import { Icon } from "../ui/Icon";

export interface SettingsSearchProps {
  index: readonly SearchEntry[];
  onPick: (entry: SearchEntry) => void;
}

export function SettingsSearch({ index, onPick }: SettingsSearchProps) {
  const base = useId();
  const listId = `${base}-results`;
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const hits = useMemo(() => searchSettings(index, query), [index, query]);

  // ⌘K / Ctrl+K while Settings is open
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
      setOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const pick = (entry: SearchEntry) => {
    setOpen(false);
    setActive(-1);
    setQuery("");
    onPick(entry);
  };

  const listed = open && query.trim() !== "" && hits.length > 0;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      const next = moveHighlight(active, event.key, hits.length);
      if (next !== null) setActive(next);
      return;
    }
    if (event.key === "Enter") {
      const hit = hits[active >= 0 ? active : 0];
      if (listed && hit) {
        event.preventDefault();
        pick(hit.entry);
      }
      return;
    }
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      if (listed) setOpen(false);
      else setQuery("");
      setActive(-1);
    }
  };

  return (
    <div className="combobox settings-search" role="search" aria-label="Settings">
      <Icon name="search" className="settings-search-icon" />
      <input
        ref={input}
        type="text"
        className="input"
        role="combobox"
        aria-label="Search settings"
        aria-expanded={listed}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={listed && active >= 0 ? `${listId}-${active}` : undefined}
        aria-keyshortcuts="Meta+K Control+K"
        autoComplete="off"
        spellCheck={false}
        placeholder="Search settings (⌘K): a name, help text or YAML key"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
      />
      <ul id={listId} role="listbox" aria-label="Matching settings" className="combobox-list settings-search-results" hidden={!listed}>
        {hits.map((hit, i) => (
          <li
            key={hit.entry.key}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            data-key={hit.entry.key}
            className={`combobox-option${i === active ? " active" : ""}`}
            // Keep the focus in the box; the click picks the field
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(hit.entry)}
          >
            <span className="settings-search-title">
              {hit.entry.label}
              <span className="muted small">
                {" "}
                · {hit.entry.sectionTitle}
                {hit.entry.level !== "basic" ? ` · ${hit.entry.level}` : ""}
              </span>
            </span>
            <code className="settings-search-key">{hit.entry.key}</code>
            {hit.matched === "help" && hit.entry.help && <span className="muted small">{hit.entry.help}</span>}
          </li>
        ))}
      </ul>
      {open && query.trim() !== "" && hits.length === 0 && (
        <div className="combobox-empty" role="status">
          No setting matches “{query.trim().slice(0, 60)}”
        </div>
      )}
    </div>
  );
}
