/**
 * Buttons: one look for every action. `variant` says what kind (primary: the
 * main action of a group; secondary: the rest; ghost: quiet, in toolbars;
 * danger: destroys or stops something; link: reads as a link). `size` is md
 * or sm (rows, tables, inline answers). ButtonLink is a link that looks
 * like a button, for actions that are navigation.
 *
 * The label is the button's own text, so the markup reads
 * `<button ...>Label</button>`; an icon goes before it, hidden from
 * screen readers. An icon-only button needs `aria-label`.
 */
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md";

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string): string {
  return `btn btn-${variant} btn-${size}${extra ? ` ${extra}` : ""}`;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, type = "button", disabled, className, children, ...rest },
  ref,
) {
  // type and disabled first: the markup reads <button type="button" disabled="" ...>
  return (
    <button type={type} disabled={disabled} className={buttonClass(variant, size, className)} ref={ref} {...rest}>
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
    </button>
  );
});

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
}

export function ButtonLink({ variant = "secondary", size = "md", icon, className, children, ...rest }: ButtonLinkProps) {
  return (
    <a className={buttonClass(variant, size, className)} {...rest}>
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
    </a>
  );
}
