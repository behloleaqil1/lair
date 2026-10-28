/**
 * An on/off switch: a button with role="switch" and aria-checked, so Space
 * and Enter toggle it and screen readers say "on" or "off". The label is its
 * visible text; `description` adds a line under it.
 */
import { useId, type ReactNode } from "react";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** Visually hide the label (it still names the switch) */
  hideLabel?: boolean;
  id?: string;
  className?: string;
}

export function Switch({ checked, onChange, label, description, disabled, hideLabel, id, className }: SwitchProps) {
  const auto = useId();
  const switchId = id ?? `switch-${auto}`;
  const labelId = `${switchId}-label`;
  const descId = description ? `${switchId}-desc` : undefined;
  return (
    <span className={`switch-field${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        id={switchId}
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descId}
        disabled={disabled}
        className="switch"
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" aria-hidden="true" />
      </button>
      <span className="switch-text">
        <span id={labelId} className={hideLabel ? "visually-hidden" : "switch-label"} onClick={() => !disabled && onChange(!checked)}>
          {label}
        </span>
        {description && (
          <span id={descId} className="switch-description">
            {description}
          </span>
        )}
      </span>
    </span>
  );
}
