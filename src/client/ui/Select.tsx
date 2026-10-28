/**
 * A native select in the kit's look (the browser's own list, so keyboard,
 * screen readers and mobile pickers work as everywhere). Pass `options`, or
 * <option> children. Name it with a Field, or `aria-label` when it stands
 * alone.
 */
import { forwardRef, type SelectHTMLAttributes } from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: readonly SelectOption[];
  /** The small size, for toolbars and footers */
  compact?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, className, compact, children, ...rest },
  ref,
) {
  return (
    <span className={`select${compact ? " select-sm" : ""}${className ? ` ${className}` : ""}`}>
      <select ref={ref} {...rest}>
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
    </span>
  );
});
