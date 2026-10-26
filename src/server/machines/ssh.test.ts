/**
 * SSH command builder tests
 *
 * CRITICAL: Tests verify command arrays are built safely for spawn()
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import {
  isSSHMachine,
  resolveKeyPath,
  buildSSHBaseArgs,
  buildSSHCommand,
  buildHealthCheckCommand,
  buildGateCommand,
  validateSSHConfig,
  isValidEnvKey,
  validateEnvVars,
} from "./ssh.js";
import type { MachineConfig, SSHMachineConfig } from "../../shared/types.js";

describe("isSSHMachine", () => {
  it("returns true for valid SSH config", () => {
    const machine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      host: "198.51.100.10",
      user: "deploy",
      key: "~/.ssh/example_key",
      runners: ["remote"],
    };
    expect(isSSHMachine(machine)).toBe(true);
  });

  it("returns false for local machine", () => {
    const machine: MachineConfig = {
      name: "Mac",
      type: "local",
      runners: ["heavy"],
    };
    expect(isSSHMachine(machine)).toBe(false);
  });

  it("returns false for SSH machine missing host", () => {
    const machine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      user: "deploy",
      key: "~/.ssh/example_key",
      runners: ["remote"],
    };
    expect(isSSHMachine(machine)).toBe(false);
  });

  it("returns false for SSH machine with empty host", () => {
    const machine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      host: "",
      user: "deploy",
      key: "~/.ssh/example_key",
      runners: ["remote"],
    };
    expect(isSSHMachine(machine)).toBe(false);
  });

  it("returns false for SSH machine missing user", () => {
    const machine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      host: "198.51.100.10",
      key: "~/.ssh/example_key",
      runners: ["remote"],
    };
    expect(isSSHMachine(machine)).toBe(false);
  });

  it("returns false for SSH machine missing key", () => {
    const machine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      host: "198.51.100.10",
      user: "deploy",
      runners: ["remote"],
    };
    expect(isSSHMachine(machine)).toBe(false);
  });
});

describe("resolveKeyPath", () => {
  it("expands ~ to home directory", () => {
    const result = resolveKeyPath("~/.ssh/example_key");
    expect(result).toBe(resolve(homedir(), ".ssh/example_key"));
  });

  it("leaves absolute paths unchanged", () => {
    const result = resolveKeyPath("/home/user/.ssh/example_key");
    expect(result).toBe("/home/user/.ssh/example_key");
  });

  it("resolves relative paths", () => {
    const result = resolveKeyPath("keys/my_key");
    expect(result).toBe(resolve(process.cwd(), "keys/my_key"));
  });
});

describe("buildSSHBaseArgs", () => {
  const machine: SSHMachineConfig = {
    name: "Build Server",
    type: "ssh",
    host: "198.51.100.10",
    user: "deploy",
    key: "~/.ssh/example_key",
    connect_timeout: 4,
    runners: ["remote"],
  };

  it("builds correct SSH args", () => {
    const args = buildSSHBaseArgs(machine);
    const keyPath = resolve(homedir(), ".ssh/example_key");

    expect(args).toEqual([
      "-i",
      keyPath,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=4",
      "deploy@198.51.100.10",
    ]);
  });

  it("uses default timeout if not specified", () => {
    const machineNoTimeout: SSHMachineConfig = {
      ...machine,
      connect_timeout: undefined as any,
    };
    const args = buildSSHBaseArgs(machineNoTimeout);

    expect(args).toContain("ConnectTimeout=4"); // default
  });

  it("uses custom timeout", () => {
    const machineCustomTimeout: SSHMachineConfig = {
      ...machine,
      connect_timeout: 10,
    };
    const args = buildSSHBaseArgs(machineCustomTimeout);

    expect(args).toContain("ConnectTimeout=10");
  });
});

describe("buildSSHCommand", () => {
  const machine: SSHMachineConfig = {
    name: "Build Server",
    type: "ssh",
    host: "198.51.100.10",
    user: "deploy",
    key: "/home/user/.ssh/example_key",
    connect_timeout: 4,
    runners: ["remote"],
  };

  it("appends remote command as final argument", () => {
    const args = buildSSHCommand(machine, "ls -la");
    expect(args[args.length - 1]).toBe("ls -la");
  });

  it("keeps command as single argument (no shell splitting)", () => {
    const args = buildSSHCommand(machine, "cd /tmp && ls");
    // The whole command string is ONE argument
    expect(args.filter((a) => a.includes("cd /tmp")).length).toBe(1);
  });
});

describe("buildHealthCheckCommand", () => {
  const machine: SSHMachineConfig = {
    name: "Build Server",
    type: "ssh",
    host: "198.51.100.10",
    user: "deploy",
    key: "/home/user/.ssh/example_key",
    connect_timeout: 4,
    runners: ["remote"],
  };

  it("builds health check command", () => {
    const args = buildHealthCheckCommand(machine);

    // Should end with the health check command
    expect(args[args.length - 1]).toBe("echo up && uptime");

    // Should include all SSH options
    expect(args).toContain("-o");
    expect(args).toContain("BatchMode=yes");
  });
});

describe("buildGateCommand", () => {
  const machine: SSHMachineConfig = {
    name: "Build Server",
    type: "ssh",
    host: "198.51.100.10",
    user: "deploy",
    key: "/home/user/.ssh/example_key",
    connect_timeout: 4,
    runners: ["remote"],
  };

  it("builds gate command with cd and script", () => {
    const args = buildGateCommand(
      machine,
      "work/bin/gate.sh",
      "/home/user/project",
      "config.yaml",
      "/tmp/worktree"
    );

    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).toContain("cd '/home/user/project'");
    expect(remoteCmd).toContain("'work/bin/gate.sh'");
    expect(remoteCmd).toContain("'config.yaml'");
    expect(remoteCmd).toContain("'/tmp/worktree'");
  });

  it("includes env vars when provided", () => {
    const args = buildGateCommand(
      machine,
      "gate.sh",
      "/home/work",
      "conf",
      "tree",
      { BACKEND_TESTS: "com.example.Test", DEBUG: "true" }
    );

    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).toContain("BACKEND_TESTS='com.example.Test'");
    expect(remoteCmd).toContain("DEBUG='true'");
  });

  // SECURITY: Shell injection prevention
  describe("shell injection prevention", () => {
    it("quotes paths with spaces", () => {
      const args = buildGateCommand(
        machine,
        "gate.sh",
        "/home/user/my project",
        "conf",
        "tree"
      );

      const remoteCmd = args[args.length - 1];
      expect(remoteCmd).toContain("'/home/user/my project'");
    });

    it("escapes single quotes in paths", () => {
      const args = buildGateCommand(
        machine,
        "gate.sh",
        "/home/user/it's here",
        "conf",
        "tree"
      );

      const remoteCmd = args[args.length - 1];
      // Should escape the quote
      expect(remoteCmd).toContain("'\\''");
    });

    it("quotes env var values", () => {
      const args = buildGateCommand(machine, "gate.sh", "/work", "c", "t", {
        MALICIOUS: "value; rm -rf /",
      });

      const remoteCmd = args[args.length - 1];
      // The semicolon is inside quotes, not a command separator
      expect(remoteCmd).toContain("MALICIOUS='value; rm -rf /'");
    });
  });
});

describe("validateSSHConfig", () => {
  it("returns no errors for local machine", () => {
    const machine: MachineConfig = {
      name: "Mac",
      type: "local",
      runners: ["heavy"],
    };
    const errors = validateSSHConfig("mac", machine);
    expect(errors).toEqual([]);
  });

  it("returns no errors for valid SSH config", () => {
    const machine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      host: "198.51.100.10",
      user: "deploy",
      key: "~/.ssh/example_key",
      runners: ["remote"],
    };
    const errors = validateSSHConfig("build-server", machine);
    expect(errors).toEqual([]);
  });

  it("returns error for missing host", () => {
    const machine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      user: "deploy",
      key: "~/.ssh/example_key",
      runners: ["remote"],
    };
    const errors = validateSSHConfig("build-server", machine);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("host");
  });

  it("returns error for empty host", () => {
    const machine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      host: "  ",
      user: "deploy",
      key: "~/.ssh/example_key",
      runners: ["remote"],
    };
    const errors = validateSSHConfig("build-server", machine);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("host");
  });

  it("returns error for missing user", () => {
    const machine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      host: "198.51.100.10",
      key: "~/.ssh/example_key",
      runners: ["remote"],
    };
    const errors = validateSSHConfig("build-server", machine);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("user");
  });

  it("returns error for missing key", () => {
    const machine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      host: "198.51.100.10",
      user: "deploy",
      runners: ["remote"],
    };
    const errors = validateSSHConfig("build-server", machine);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("key");
  });

  it("returns all errors for completely invalid SSH config", () => {
    const machine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      runners: ["remote"],
    };
    const errors = validateSSHConfig("build-server", machine);
    expect(errors.length).toBe(3); // host, user, key
  });

  it("returns error for invalid connect_timeout", () => {
    const machine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      host: "198.51.100.10",
      user: "deploy",
      key: "~/.ssh/example_key",
      connect_timeout: 0,
      runners: ["remote"],
    };
    const errors = validateSSHConfig("build-server", machine);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("connect_timeout");
  });
});

// SECURITY: env var names come from gate request files written by agents
describe("gate env var validation", () => {
  const machine: SSHMachineConfig = {
    name: "Build Server",
    type: "ssh",
    host: "198.51.100.10",
    user: "deploy",
    key: "/home/user/.ssh/example_key",
    connect_timeout: 4,
    runners: ["remote"],
  };

  it.each([
    "X=1;touch /tmp/pwned;Y",
    "$(id)",
    "A B",
    "1ABC",
    "",
    "PATH",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "BASH_ENV",
    "NODE_OPTIONS",
  ])("rejects env var name %j", (key) => {
    expect(isValidEnvKey(key)).toBe(false);
    expect(() =>
      buildGateCommand(machine, "gate.sh", "/work", "c", "t", { [key]: "v" }),
    ).toThrow("Invalid gate environment");
  });

  it("accepts plain identifiers", () => {
    expect(isValidEnvKey("BACKEND_TESTS")).toBe(true);
    expect(isValidEnvKey("_private1")).toBe(true);
    expect(validateEnvVars({ A: "1", B_2: "x" })).toEqual([]);
  });

  it("rejects non-string values and non-object envVars", () => {
    expect(validateEnvVars({ A: 1 })).toHaveLength(1);
    expect(validateEnvVars(["A=1"])).toHaveLength(1);
    expect(validateEnvVars("A=1")).toHaveLength(1);
    expect(validateEnvVars(undefined)).toEqual([]);
  });

  it("applies env vars to the gate script, not just to cd", () => {
    const dir = mkdtempSync(join(tmpdir(), "lair-gate-env-"));
    try {
      const script = join(dir, "gate.sh");
      writeFileSync(script, '#!/bin/sh\nprintf "%s" "$GATE_SCOPE"\n');
      chmodSync(script, 0o755);
      const args = buildGateCommand(machine, script, dir, "c", "t", {
        GATE_SCOPE: "it's scoped",
      });
      // Run the remote command string the way the remote shell would
      const out = execFileSync("sh", ["-c", args[args.length - 1]], {
        encoding: "utf-8",
      });
      expect(out).toBe("it's scoped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
