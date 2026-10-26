/**
 * Node Registration for lair-node
 *
 * Handles node identity generation, key pair management, and server registration.
 * Stores configuration in ~/.lair/node/
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import type { NodeConfig } from "../shared/node-types.js";

/** Directory where node configuration is stored */
const LAIR_DIR = join(homedir(), ".lair");
const NODE_DIR = join(LAIR_DIR, "node");
const CONFIG_FILE = join(NODE_DIR, "config.json");
const PID_FILE = join(NODE_DIR, "daemon.pid");

/**
 * Ensure the node configuration directory exists.
 */
export function ensureNodeDir(): void {
  if (!existsSync(LAIR_DIR)) {
    mkdirSync(LAIR_DIR, { recursive: true });
  }
  if (!existsSync(NODE_DIR)) {
    mkdirSync(NODE_DIR, { recursive: true });
  }
}

/**
 * Check if node is already registered.
 */
export function isRegistered(): boolean {
  return existsSync(CONFIG_FILE);
}

/**
 * Load node configuration from disk.
 */
export function loadConfig(): NodeConfig | null {
  if (!existsSync(CONFIG_FILE)) {
    return null;
  }

  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(content) as NodeConfig;
  } catch (error) {
    console.error("Failed to load node config:", error);
    return null;
  }
}

/**
 * Save node configuration to disk.
 */
export function saveConfig(config: NodeConfig): void {
  ensureNodeDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Generate a new node ID.
 */
export function generateNodeId(): string {
  // Use a UUID with a prefix for readability
  const uuid = randomUUID();
  return `node-${uuid.slice(0, 8)}`;
}

/**
 * Generate a key pair for signing job results.
 * NOTE: For M1, this is a stub that generates placeholder keys.
 * Real crypto implementation comes later.
 */
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  // M1 stub: generate placeholder keys
  // In a real implementation, this would use crypto.generateKeyPairSync
  const nodeId = generateNodeId();
  const timestamp = Date.now();

  // Placeholder PEM-like format
  const privateKey = `-----BEGIN LAIR PRIVATE KEY-----
M1-STUB-PRIVATE-${nodeId}-${timestamp}
-----END LAIR PRIVATE KEY-----`;

  const publicKey = `-----BEGIN LAIR PUBLIC KEY-----
M1-STUB-PUBLIC-${nodeId}-${timestamp}
-----END LAIR PUBLIC KEY-----`;

  return { privateKey, publicKey };
}

/**
 * Sign data with the node's private key.
 * NOTE: For M1, this is a stub that returns a placeholder signature.
 */
export function signData(data: string, _privateKey: string): string {
  // M1 stub: return a placeholder signature
  const timestamp = Date.now();
  return `M1-STUB-SIG-${timestamp}-${Buffer.from(data).toString("base64").slice(0, 16)}`;
}

/**
 * Initialize a new node configuration.
 * Called on first start or when joining a server.
 */
export function initializeNode(serverUrl: string): NodeConfig {
  ensureNodeDir();

  // Check if already registered
  const existing = loadConfig();
  if (existing) {
    // Update server URL if different
    if (existing.serverUrl !== serverUrl) {
      existing.serverUrl = serverUrl;
      saveConfig(existing);
    }
    return existing;
  }

  // Generate new identity
  const nodeId = generateNodeId();
  const { privateKey, publicKey } = generateKeyPair();

  const config: NodeConfig = {
    nodeId,
    serverUrl,
    privateKey,
    publicKey,
    registeredAt: new Date().toISOString(),
  };

  saveConfig(config);
  return config;
}

/**
 * Store the server-issued certificate after registration.
 */
export function storeCertificate(certificate: string): void {
  const config = loadConfig();
  if (!config) {
    throw new Error("Node not configured");
  }

  config.certificate = certificate;
  saveConfig(config);
}

/**
 * Get the node configuration directory.
 */
export function getNodeDir(): string {
  return NODE_DIR;
}

/**
 * Get the PID file path.
 */
export function getPidFile(): string {
  return PID_FILE;
}

/**
 * Write the daemon PID to the PID file.
 */
export function writePidFile(pid: number): void {
  ensureNodeDir();
  writeFileSync(PID_FILE, pid.toString(), "utf-8");
}

/**
 * Read the daemon PID from the PID file.
 */
export function readPidFile(): number | null {
  if (!existsSync(PID_FILE)) {
    return null;
  }

  try {
    const content = readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Remove the PID file.
 */
export function removePidFile(): void {
  if (existsSync(PID_FILE)) {
    try {
      unlinkSync(PID_FILE);
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Check if a process with the given PID is running.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // Send signal 0 to check if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the daemon is currently running.
 */
export function isDaemonRunning(): { running: boolean; pid?: number } {
  const pid = readPidFile();
  if (pid === null) {
    return { running: false };
  }

  if (isProcessRunning(pid)) {
    return { running: true, pid };
  }

  // Stale PID file
  removePidFile();
  return { running: false };
}
