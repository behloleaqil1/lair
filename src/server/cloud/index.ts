/**
 * Cloud machines: a provider per account (AWS EC2 first), Lair's spend
 * meter and the money guard (docs/configuration.md#cloud-machines). Started
 * and stopped by src/server/index.ts; off unless a project sets
 * `cloud.enabled: true`. Its route is read-only.
 */
export { CloudMachines, CloudManager } from "./service.js";
export type { ClientsFactory, ProjectEntry, StartResult } from "./service.js";
export { registerCloudRoutes } from "./routes.js";
export { CloudSchema, parseCloudConfig } from "./config.js";
export type { CloudSettings } from "./config.js";
export { AwsEc2Provider, sdkClients } from "./provider.js";
export type { AwsClients, CloudProvider } from "./provider.js";
export { CloudStore } from "./store.js";
