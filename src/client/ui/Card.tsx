/**
 * Cards and callouts. Card: a surface with an optional title and actions.
 * Callout: a message in a tone with its icon (an error, a warning, a note);
 * `alert` makes it a live alert for something that just went wrong.
 */
import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";
import { TONE_ICON, type Tone } from "./tokens";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

export function Card({ title, actions, children, className, ...rest }: CardProps) {
  return (
    <div className={`card${className ? ` ${className}` : ""}`} {...rest}>
      {(title || actions) && (
        <div className="card-header">
          {title && <h3 className="card-title">{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export interface CalloutProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  alert?: boolean;
}

export function Callout({ tone = "info", title, children, alert, className, ...rest }: CalloutProps) {
  return (
    <div className={`callout callout-${tone}${className ? ` ${className}` : ""}`} role={alert ? "alert" : undefined} {...rest}>
      <Icon name={TONE_ICON[tone]} className="callout-icon" />
      <div className="callout-body">
        {title && <strong className="callout-title">{title}</strong>}
        {children}
      </div>
    </div>
  );
}
