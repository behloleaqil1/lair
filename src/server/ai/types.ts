/**
 * What other modules ask the AI tools service (tools.ts), in-process.
 */
import type { SignInState } from "../../shared/ai-types.js";
import type { ProjectConfig } from "../../shared/types.js";

/** A tool that may not start on a machine: its sign-in check says it is signed out there. */
export interface SignInRefusal {
  tool: string;
  /** The tool's display name */
  name: string;
  machine: string;
  /** What the check found, in words */
  detail: string;
  /** The command the owner runs in a terminal on that machine to sign in (the preset's login_hint), or null */
  fix: string | null;
  /** The check that was run, for the record */
  check: string[];
}

/**
 * The agents module asks before it starts a run on a tool, on this machine
 * (it starts its runs here). AiToolsService has it.
 */
export interface ToolReadiness {
  /**
   * A refusal when the tool's sign-in check (cached briefly) says it is
   * signed out on this machine; null when it is signed in, when the check
   * can't tell, and for a tool without a check.
   */
  signInRefusal(tool: string, config: ProjectConfig): Promise<SignInRefusal | null>;
  /** The tool's sign-in state here as last checked, without checking now (null: never checked, or no check) */
  lastSignIn(tool: string, config: ProjectConfig): SignInState | null;
  /** Check the tool again at its next use (the owner says they signed in) */
  forget(tool: string): void;
}
