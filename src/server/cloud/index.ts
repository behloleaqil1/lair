/**
 * Cloud machines: a provider per account (AWS EC2 first), Lair's spend
 * meter and the money guard (docs/configuration.md#cloud-machines). Started
 * and stopped by src/server/index.ts; off unless a project sets
 * `cloud.enabled: true`. Its routes are the owner's.
 *
 * The provider and the SDK clients are not exported here: a start goes
 * through CloudMachines.startMachine(), which runs the money guard first,
 * and nothing outside this folder gets a provider to call start() on.
 */
export { CloudMachines, CloudManager } from "./service.js";
export type { ClientsFactory, ProjectEntry, StartResult } from "./service.js";
export { registerCloudRoutes } from "./routes.js";
export { CloudSchema, parseCloudConfig } from "./config.js";
export type { CloudSettings } from "./config.js";
export type { AwsClients } from "./provider.js";
export { CloudStore } from "./store.js";
