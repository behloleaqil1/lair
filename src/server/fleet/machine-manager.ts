/**
 * Machine manager for fleet management.
 * Handles adding, removing, and monitoring machines.
 */
import { spawn } from "child_process";
import { getEventBus } from "../core/event-bus.js";
import { resolveKeyPath } from "../machines/ssh.js";
import type {
  Machine,
  MachineStatus,
  AddMachineRequest,
  InstallationStatus,
  SSHMachineConfig,
} from "../../shared/fleet-types.js";

/** Machine installation progress */
const installationProgress = new Map<string, InstallationStatus>();

/**
 * Machine manager for the fleet.
 */
export class MachineManager {
  private machines = new Map<string, Machine>();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckMs = 30000; // 30 seconds

  constructor() {
    // Health check interval
    this.healthCheckInterval = setInterval(() => {
      this.checkAllMachines();
    }, this.healthCheckMs);
  }

  /**
   * Add a new machine to the fleet.
   */
  async addMachine(request: AddMachineRequest): Promise<Machine> {
    const id = `machine-${request.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
    const now = new Date().toISOString();

    // Check if machine already exists
    if (this.machines.has(id)) {
      throw new Error(`Machine '${request.name}' already exists`);
    }

    // For SSH machines, require SSH config
    if (request.type === "ssh" && !request.ssh) {
      throw new Error(`SSH machines require ssh configuration (host, user, key)`);
    }

    const machine: Machine = {
      id,
      name: request.name,
      type: request.type,
      status: request.type === "local" ? "online" : "provisioning",
      ssh: request.ssh,
      runners: request.runners ?? ["heavy"],
      maxAgents: request.maxAgents ?? 4,
      createdAt: now,
      updatedAt: now,
    };

    // For SSH machines, verify connectivity first
    if (machine.type === "ssh" && machine.ssh) {
      const reachable = await this.checkSSHConnectivity(machine.ssh);
      if (!reachable) {
        machine.status = "error";
        machine.error = "Cannot connect to machine via SSH";
      }
    }

    this.machines.set(id, machine);

    // Emit event
    const eventBus = getEventBus();
    await eventBus.emit("node.registered", { nodeId: id, name: machine.name, type: machine.type });

    // If requested, install lair-node
    if (request.installNode && machine.type === "ssh" && machine.ssh && machine.status !== "error") {
      this.installNode(machine).catch((err) => {
        console.error(`[MachineManager] Failed to install node on ${machine.name}:`, err);
        machine.status = "error";
        machine.error = err.message;
      });
    }

    return machine;
  }

  /**
   * Remove a machine from the fleet.
   */
  async removeMachine(machineId: string): Promise<boolean> {
    const machine = this.machines.get(machineId);
    if (!machine) {
      return false;
    }

    // TODO: Stop any running jobs on this machine

    this.machines.delete(machineId);

    const eventBus = getEventBus();
    await eventBus.emit("node.offline", { nodeId: machineId });

    return true;
  }

  /**
   * Get a machine by ID.
   */
  getMachine(machineId: string): Machine | undefined {
    return this.machines.get(machineId);
  }

  /**
   * List all machines.
   */
  listMachines(): Machine[] {
    return Array.from(this.machines.values());
  }

  /**
   * Get online machines.
   */
  getOnlineMachines(): Machine[] {
    return this.listMachines().filter((m) => m.status === "online");
  }

  /**
   * Update machine status.
   */
  updateMachineStatus(machineId: string, status: MachineStatus, error?: string): void {
    const machine = this.machines.get(machineId);
    if (machine) {
      machine.status = status;
      machine.error = error;
      machine.updatedAt = new Date().toISOString();
      if (status === "online") {
        machine.lastSeen = machine.updatedAt;
      }
    }
  }

  /**
   * Get installation status for a machine.
   */
  getInstallationStatus(machineId: string): InstallationStatus | undefined {
    return installationProgress.get(machineId);
  }

  /**
   * Check SSH connectivity.
   */
  async checkSSHConnectivity(ssh: SSHMachineConfig): Promise<boolean> {
    return new Promise((resolve) => {
      const args = [
        "-i", resolveKeyPath(ssh.key),
        "-o", "IdentitiesOnly=yes",
        "-o", "BatchMode=yes",
        "-o", `ConnectTimeout=${ssh.connect_timeout ?? 5}`,
        "-p", String(ssh.port ?? 22),
        `${ssh.user}@${ssh.host}`,
        "echo", "ok",
      ];

      const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";

      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      proc.on("close", (code) => {
        resolve(code === 0 && stdout.trim() === "ok");
      });
      proc.on("error", () => resolve(false));

      // Timeout
      setTimeout(() => {
        proc.kill();
        resolve(false);
      }, (ssh.connect_timeout ?? 5) * 1000 + 1000);
    });
  }

  /**
   * Install lair-node on a remote machine via SSH.
   */
  async installNode(machine: Machine): Promise<void> {
    if (!machine.ssh) {
      throw new Error("Machine has no SSH config");
    }

    const updateProgress = (
      step: InstallationStatus["step"],
      progress: number,
      message: string,
      error?: string
    ) => {
      const status: InstallationStatus = {
        machineId: machine.id,
        step,
        progress,
        message,
        error,
      };
      installationProgress.set(machine.id, status);
      console.log(`[MachineManager] ${machine.name}: ${message}`);
    };

    try {
      updateProgress("connecting", 10, "Connecting to machine...");

      // Step 1: Check connectivity
      const reachable = await this.checkSSHConnectivity(machine.ssh);
      if (!reachable) {
        throw new Error("Cannot connect to machine via SSH");
      }

      updateProgress("checking", 20, "Checking system requirements...");

      // Step 2: Check if Node.js is installed
      const hasNode = await this.execSSH(machine.ssh, "node --version 2>/dev/null || echo 'NOT_INSTALLED'");
      if (hasNode.includes("NOT_INSTALLED")) {
        updateProgress("installing", 30, "Installing Node.js...");
        // Try to install Node.js
        await this.execSSH(machine.ssh, "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs || brew install node");
      }

      updateProgress("installing", 50, "Installing lair-node...");

      // Step 3: Install lair-node package (or copy from local)
      // For now, assume lair-node is available via npm or we copy the binary
      await this.execSSH(machine.ssh, "npm install -g lair-node 2>/dev/null || echo 'Installing from source...'");

      updateProgress("configuring", 70, "Configuring lair-node...");

      // Step 4: Configure lair-node with server URL
      // The node needs to know where to connect
      const serverUrl = `http://127.0.0.1:4777`; // TODO: Get actual server URL
      await this.execSSH(machine.ssh, `mkdir -p ~/.lair && echo '{"serverUrl":"${serverUrl}","nodeId":"${machine.id}"}' > ~/.lair/node-config.json`);

      updateProgress("starting", 85, "Starting lair-node daemon...");

      // Step 5: Start the daemon
      await this.execSSH(machine.ssh, "nohup lair-node daemon > ~/.lair/node.log 2>&1 &");

      updateProgress("verifying", 95, "Verifying node connection...");

      // Step 6: Wait for node to connect
      // The node manager will handle this when the node registers
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Mark machine as online
      this.updateMachineStatus(machine.id, "online");
      updateProgress("done", 100, "Installation complete");

    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.updateMachineStatus(machine.id, "error", message);
      updateProgress("error", 0, `Installation failed: ${message}`, message);
      throw error;
    }
  }

  /**
   * Execute a command on a remote machine via SSH.
   */
  private async execSSH(ssh: SSHMachineConfig, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "-i", resolveKeyPath(ssh.key),
        "-o", "IdentitiesOnly=yes",
        "-o", "BatchMode=yes",
        "-o", `ConnectTimeout=${ssh.connect_timeout ?? 5}`,
        "-p", String(ssh.port ?? 22),
        `${ssh.user}@${ssh.host}`,
        command,
      ];

      const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      proc.stderr.on("data", (data) => { stderr += data.toString(); });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(stderr || `Command failed with code ${code}`));
        }
      });

      proc.on("error", reject);

      // Timeout after 60 seconds
      setTimeout(() => {
        proc.kill();
        reject(new Error("Command timed out"));
      }, 60000);
    });
  }

  /**
   * Check health of all machines.
   */
  async checkAllMachines(): Promise<void> {
    for (const machine of this.machines.values()) {
      if (machine.type === "local") {
        // Local machine is always online if the server is running
        this.updateMachineStatus(machine.id, "online");
        continue;
      }

      if (machine.type === "ssh" && machine.ssh) {
        try {
          const reachable = await this.checkSSHConnectivity(machine.ssh);
          if (reachable && machine.status !== "provisioning") {
            if (machine.status !== "online") {
              console.log(`[MachineManager] ${machine.name} is back online`);
              const eventBus = getEventBus();
              await eventBus.emit("node.online", { nodeId: machine.id });
            }
            this.updateMachineStatus(machine.id, "online");
          } else if (!reachable && machine.status === "online") {
            console.log(`[MachineManager] ${machine.name} went offline`);
            this.updateMachineStatus(machine.id, "offline");
            const eventBus = getEventBus();
            await eventBus.emit("node.offline", { nodeId: machine.id });
          }
        } catch (error) {
          // Ignore errors during health check
        }
      }
    }
  }

  /**
   * Stop the machine manager.
   */
  stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
}

// Global singleton
let globalMachineManager: MachineManager | null = null;

/**
 * Get or create the global machine manager.
 */
export function getMachineManager(): MachineManager {
  if (!globalMachineManager) {
    globalMachineManager = new MachineManager();
  }
  return globalMachineManager;
}

/**
 * Stop the machine manager.
 */
export function stopMachineManager(): void {
  globalMachineManager?.stop();
  globalMachineManager = null;
}
