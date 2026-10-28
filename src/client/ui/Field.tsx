/**
 * A form field: its label, one line of help, and the error when there is
 * one, wired to the control (label `for`, `aria-describedby`,
 * `aria-invalid`). The control is the one child (Input, TextArea, Select,
 * Combobox or a native control); Field gives it its id unless it has one.
 *
 *   <Field label="Max active" help="Runs fill starts at once" error={err}>
 *     <Input value={v} onChange={...} />
 *   </Field>
 */
import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

export interface FieldProps {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  /** Shown after the label: "(optional)", the YAML key, ... */
  hint?: ReactNode;
  /** Visually hide the label (it is still the control's name) */
  hideLabel?: boolean;
  className?: string;
  children: ReactElement;
}

interface ControlProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

export function Field({ label, help, error, hint, hideLabel, className, children }: FieldProps) {
  const auto = useId();
  const child = isValidElement<ControlProps>(children) ? children : null;
  const id = child?.props.id ?? `field-${auto}`;
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [child?.props["aria-describedby"], helpId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field${error ? " field-invalid" : ""}${className ? ` ${className}` : ""}`}>
      <label htmlFor={id} className={hideLabel ? "field-label visually-hidden" : "field-label"}>
        {label}
        {hint && <span className="field-hint"> {hint}</span>}
      </label>
      {child
        ? cloneElement(child, {
            id,
            "aria-describedby": describedBy,
            "aria-invalid": error ? true : child.props["aria-invalid"],
          })
        : children}
      {help && (
        <p id={helpId} className="field-help">
          {help}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, type = "text", ...rest },
  ref,
) {
  return <input type={type} className={className ? `input ${className}` : "input"} ref={ref} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, ...rest },
  ref,
) {
  return <textarea className={className ? `input textarea ${className}` : "input textarea"} ref={ref} {...rest} />;
});
