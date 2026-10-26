/**
 * Remote gate execution tests
 *
 * Tests SSH command building and gate execution (mocked SSH).
 * Actual SSH connections are NOT tested - only command construction
 * and process handling logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";
import {
  buildSshGateCommand,
  executeRemoteGate,
  executeLocalGate,
  executeGate,
} from "./remote-gate.js";
import type { MachineConfig, SSHMachineConfig } from "../../shared/types.js";
import { homedir } from "os";
import { resolve } from "path";

// Mock child_process.spawn
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(spawn);

describe("buildSshGateCommand", () => {
  const sshMachine: SSHMachineConfig = {
    name: "Build Server",
    type: "ssh",
    host: "198.51.100.10",
    user: "deploy",
    key: "~/.ssh/example_key",
    connect_timeout: 4,
    runners: ["remote"],
    work_dir: "/home/user/project",
  };

  it("builds SSH command with correct arguments", () => {
    const args = buildSshGateCommand(
      sshMachine,
      "work/bin/gate.sh",
      "config.yaml",
      "/tmp/worktree",
    );

    const keyPath = resolve(homedir(), ".ssh/example_key");

    // Check SSH base args
    expect(args).toContain("-i");
    expect(args).toContain(keyPath);
    expect(args).toContain("-o");
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ConnectTimeout=4");
    expect(args).toContain("deploy@198.51.100.10");

    // Check remote command
    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).toContain("cd '/home/user/project'");
    expect(remoteCmd).toContain("'work/bin/gate.sh'");
    expect(remoteCmd).toContain("'config.yaml'");
    expect(remoteCmd).toContain("'/tmp/worktree'");
  });

  it("uses worktree as work_dir if not configured", () => {
    const machineNoWorkDir: SSHMachineConfig = {
      ...sshMachine,
      work_dir: undefined,
    };

    const args = buildSshGateCommand(
      machineNoWorkDir,
      "gate.sh",
      "conf",
      "/my/worktree",
    );

    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).toContain("cd '/my/worktree'");
  });

  it("includes environment variables", () => {
    const args = buildSshGateCommand(sshMachine, "gate.sh", "conf", "tree", {
      BACKEND_TESTS: "com.example.Test",
      DEBUG: "1",
    });

    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).toContain("BACKEND_TESTS='com.example.Test'");
    expect(remoteCmd).toContain("DEBUG='1'");
  });

  // Security: shell injection prevention
  describe("shell injection prevention", () => {
    it("quotes paths with special characters", () => {
      const args = buildSshGateCommand(
        sshMachine,
        "gate.sh",
        "config; rm -rf /",
        "tree",
      );

      const remoteCmd = args[args.length - 1];
      // The semicolon should be quoted, not a command separator
      expect(remoteCmd).toContain("'config; rm -rf /'");
    });

    it("escapes single quotes in values", () => {
      const args = buildSshGateCommand(
        sshMachine,
        "gate.sh",
        "it's a test",
        "tree",
      );

      const remoteCmd = args[args.length - 1];
      // Single quotes should be escaped
      expect(remoteCmd).toContain("'\\''");
    });

    it("quotes env var values with special chars", () => {
      const args = buildSshGateCommand(sshMachine, "gate.sh", "conf", "tree", {
        EVIL: "value; rm -rf /",
      });

      const remoteCmd = args[args.length - 1];
      expect(remoteCmd).toContain("EVIL='value; rm -rf /'");
    });
  });
});

describe("executeRemoteGate", () => {
  let mockProcess: {
    stdout: { on: ReturnType<typeof vi.fn> };
    stderr: { on: ReturnType<typeof vi.fn> };
    on: ReturnType<typeof vi.fn>;
    killed: boolean;
    kill: ReturnType<typeof vi.fn> | (() => void);
    pid: number;
  };

  beforeEach(() => {
    mockProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      killed: false,
      kill: vi.fn().mockImplementation(() => {
        mockProcess.killed = true;
      }),
      pid: 12345,
    };

    mockSpawn.mockReturnValue(mockProcess as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const sshMachine: MachineConfig = {
    name: "Build Server",
    type: "ssh",
    host: "198.51.100.10",
    user: "deploy",
    key: "~/.ssh/example_key",
    runners: ["remote"],
    work_dir: "/home/user/project",
  };

  it("rejects non-SSH machines", async () => {
    const localMachine: MachineConfig = {
      name: "Mac",
      type: "local",
      runners: ["heavy"],
    };

    const gateProcess = executeRemoteGate(
      localMachine,
      "gate.sh",
      "conf",
      "tree",
    );

    expect(gateProcess.pid).toBe(-1);
    const result = await gateProcess.promise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid machine type");
  });

  it("spawns SSH with correct command", () => {
    executeRemoteGate(sshMachine, "gate.sh", "conf", "tree");

    expect(mockSpawn).toHaveBeenCalledWith("ssh", expect.any(Array), {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("returns process handle with pid and kill", () => {
    const gateProcess = executeRemoteGate(
      sshMachine,
      "gate.sh",
      "conf",
      "tree",
    );

    expect(gateProcess.pid).toBe(12345);
    expect(typeof gateProcess.kill).toBe("function");
    expect(typeof gateProcess.promise).toBe("object");
  });

  it("calls onStart callback with pid", () => {
    const onStart = vi.fn();

    executeRemoteGate(sshMachine, "gate.sh", "conf", "tree", { onStart });

    expect(onStart).toHaveBeenCalledWith(12345);
  });

  it("streams stdout to callback", () => {
    const onStdout = vi.fn();

    executeRemoteGate(sshMachine, "gate.sh", "conf", "tree", { onStdout });

    // Get the stdout handler
    const stdoutHandler = mockProcess.stdout.on.mock.calls.find(
      (call) => call[0] === "data",
    )?.[1];

    expect(stdoutHandler).toBeDefined();

    // Simulate stdout data
    stdoutHandler(Buffer.from("output line 1\n"));
    stdoutHandler(Buffer.from("output line 2\n"));

    expect(onStdout).toHaveBeenCalledTimes(2);
    expect(onStdout).toHaveBeenCalledWith("output line 1\n");
    expect(onStdout).toHaveBeenCalledWith("output line 2\n");
  });

  it("streams stderr to callback", () => {
    const onStderr = vi.fn();

    executeRemoteGate(sshMachine, "gate.sh", "conf", "tree", { onStderr });

    const stderrHandler = mockProcess.stderr.on.mock.calls.find(
      (call) => call[0] === "data",
    )?.[1];

    expect(stderrHandler).toBeDefined();

    stderrHandler(Buffer.from("error output\n"));

    expect(onStderr).toHaveBeenCalledWith("error output\n");
  });

  it("resolves with success on exit code 0", async () => {
    const gateProcess = executeRemoteGate(
      sshMachine,
      "gate.sh",
      "conf",
      "tree",
    );

    // Get the close handler
    const closeHandler = mockProcess.on.mock.calls.find(
      (call) => call[0] === "close",
    )?.[1];

    // Simulate successful completion
    closeHandler(0);

    const result = await gateProcess.promise;
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("resolves with failure on non-zero exit code", async () => {
    const gateProcess = executeRemoteGate(
      sshMachine,
      "gate.sh",
      "conf",
      "tree",
    );

    const closeHandler = mockProcess.on.mock.calls.find(
      (call) => call[0] === "close",
    )?.[1];

    closeHandler(1);

    const result = await gateProcess.promise;
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("handles process errors", async () => {
    const gateProcess = executeRemoteGate(
      sshMachine,
      "gate.sh",
      "conf",
      "tree",
    );

    const errorHandler = mockProcess.on.mock.calls.find(
      (call) => call[0] === "error",
    )?.[1];

    errorHandler(new Error("Connection refused"));

    const result = await gateProcess.promise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Connection refused");
  });

  it("collects stdout and stderr in result", async () => {
    const gateProcess = executeRemoteGate(
      sshMachine,
      "gate.sh",
      "conf",
      "tree",
    );

    const stdoutHandler = mockProcess.stdout.on.mock.calls.find(
      (call) => call[0] === "data",
    )?.[1];
    const stderrHandler = mockProcess.stderr.on.mock.calls.find(
      (call) => call[0] === "data",
    )?.[1];
    const closeHandler = mockProcess.on.mock.calls.find(
      (call) => call[0] === "close",
    )?.[1];

    stdoutHandler(Buffer.from("stdout data\n"));
    stderrHandler(Buffer.from("stderr data\n"));
    closeHandler(0);

    const result = await gateProcess.promise;
    expect(result.stdout).toBe("stdout data\n");
    expect(result.stderr).toBe("stderr data\n");
  });

  it("kill() terminates the process", () => {
    const gateProcess = executeRemoteGate(
      sshMachine,
      "gate.sh",
      "conf",
      "tree",
    );

    gateProcess.kill();

    expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("passes env vars to command", () => {
    executeRemoteGate(sshMachine, "gate.sh", "conf", "tree", {
      envVars: { MY_VAR: "value" },
    });

    const args = mockSpawn.mock.calls[0][1];
    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).toContain("MY_VAR='value'");
  });
});

describe("executeLocalGate", () => {
  let mockProcess: {
    stdout: { on: ReturnType<typeof vi.fn> };
    stderr: { on: ReturnType<typeof vi.fn> };
    on: ReturnType<typeof vi.fn>;
    killed: boolean;
    kill: ReturnType<typeof vi.fn> | (() => void);
    pid: number;
  };

  beforeEach(() => {
    mockProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      killed: false,
      kill: vi.fn().mockImplementation(() => {
        mockProcess.killed = true;
      }),
      pid: 54321,
    };

    mockSpawn.mockReturnValue(mockProcess as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("spawns gate script directly (no SSH)", () => {
    executeLocalGate("./gate.sh", "config.yaml", "/tmp/worktree");

    expect(mockSpawn).toHaveBeenCalledWith(
      "./gate.sh",
      ["config.yaml", "/tmp/worktree"],
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("passes environment variables", () => {
    executeLocalGate("gate.sh", "conf", "tree", {
      envVars: { TEST_VAR: "123" },
    });

    const options = mockSpawn.mock.calls[0][2];
    expect(options.env).toMatchObject({ TEST_VAR: "123" });
  });

  it("returns process handle", () => {
    const gateProcess = executeLocalGate("gate.sh", "conf", "tree");

    expect(gateProcess.pid).toBe(54321);
    expect(typeof gateProcess.kill).toBe("function");
  });
});

describe("executeGate", () => {
  let mockProcess: {
    stdout: { on: ReturnType<typeof vi.fn> };
    stderr: { on: ReturnType<typeof vi.fn> };
    on: ReturnType<typeof vi.fn>;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };

  beforeEach(() => {
    mockProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      killed: false,
      kill: vi.fn(),
      pid: 11111,
    };

    mockSpawn.mockReturnValue(mockProcess as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses local execution for local machines", () => {
    const localMachine: MachineConfig = {
      name: "Mac",
      type: "local",
      runners: ["heavy"],
    };

    executeGate(localMachine, "gate.sh", "conf", "tree");

    // Should spawn gate.sh directly, not ssh
    expect(mockSpawn).toHaveBeenCalledWith(
      "gate.sh",
      ["conf", "tree"],
      expect.any(Object),
    );
  });

  it("uses SSH execution for ssh machines", () => {
    const sshMachine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      host: "198.51.100.10",
      user: "deploy",
      key: "~/.ssh/example_key",
      runners: ["remote"],
    };

    executeGate(sshMachine, "gate.sh", "conf", "tree");

    // Should spawn ssh
    expect(mockSpawn).toHaveBeenCalledWith(
      "ssh",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("uses machine gate_script if configured", () => {
    const sshMachine: MachineConfig = {
      name: "Build Server",
      type: "ssh",
      host: "198.51.100.10",
      user: "deploy",
      key: "~/.ssh/example_key",
      runners: ["remote"],
      gate_script: "custom/gate.sh",
    };

    executeGate(sshMachine, "default/gate.sh", "conf", "tree");

    const args = mockSpawn.mock.calls[0][1];
    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).toContain("'custom/gate.sh'");
  });
});

// SECURITY: env var names from .req files must be validated before use
describe("gate env var validation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const sshMachine: MachineConfig = {
    name: "Build Server",
    type: "ssh",
    host: "198.51.100.10",
    user: "deploy",
    key: "~/.ssh/example_key",
    runners: ["remote"],
  };

  it("refuses an injected env var name on SSH machines without spawning", async () => {
    const gate = executeRemoteGate(sshMachine, "gate.sh", "c", "t", {
      envVars: { "X=1;touch /tmp/pwned;Y": "v" },
    });
    const result = await gate.promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid gate environment");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("refuses loader variables on local machines without spawning", async () => {
    const gate = executeLocalGate("gate.sh", "c", "t", {
      envVars: { LD_PRELOAD: "/tmp/evil.so" },
    });
    const result = await gate.promise;
    expect(result.success).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
