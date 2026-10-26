/**
 * Requests the Delivery view sends: the routes in src/server/delivery/routes.ts.
 * Kept apart from the component so tests can send the same requests to the
 * real router.
 */
import type { Operation } from "../shared/delivery-types";

export type EnvironmentAction = "up" | "down" | "restart" | "deploy";
export type ServiceAction = "up" | "down" | "restart" | "deploy" | "release";
export type DeliveryAction = EnvironmentAction | ServiceAction;

/** Down, Restart and Deploy ask first; the server refuses them without `confirm: true`. */
export function needsConfirmation(action: DeliveryAction): boolean {
  return action === "down" || action === "restart" || action === "deploy";
}

/** Down holds what it stops, so it asks for a reason. */
export function needsReason(action: DeliveryAction): boolean {
  return action === "down";
}

export interface ActionTarget {
  project: string;
  environment: string;
  /** Undefined for the whole environment */
  service?: string;
}

export function deliveryActionUrl(target: ActionTarget, action: DeliveryAction): string {
  const env = encodeURIComponent(target.environment);
  const path =
    target.service === undefined
      ? `/api/delivery/environments/${env}/${action}`
      : `/api/delivery/environments/${env}/services/${encodeURIComponent(target.service)}/${action}`;
  return `${path}?project=${encodeURIComponent(target.project)}`;
}

export function deliveryActionBody(
  action: DeliveryAction,
  options: { confirmed?: boolean; reason?: string } = {},
): { confirm?: boolean; reason?: string } {
  return {
    ...(needsConfirmation(action) ? { confirm: options.confirmed === true } : {}),
    ...(needsReason(action) && options.reason ? { reason: options.reason } : {}),
  };
}

/** POST an action; resolves with the operation, or throws with the server's error. */
export async function runDeliveryAction(
  target: ActionTarget,
  action: DeliveryAction,
  options: { confirmed?: boolean; reason?: string } = {},
): Promise<Operation> {
  const res = await fetch(deliveryActionUrl(target, action), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(deliveryActionBody(action, options)),
  });
  const json = (await res.json()) as { success: boolean; data?: Operation; error?: string };
  if (!json.success || !json.data) {
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return json.data;
}
