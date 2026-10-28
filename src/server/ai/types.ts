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
  /** Fixed words ("not signed in"): never the check's output */
  detail: string;
  /** The command the owner runs in a terminal on that machine to sign in (the preset's login_hint), or null */
  fix: string | null;
  /** The check that was run, for the record */
  check: string[];
  /** When the check answered (ms since the epoch) */
  checkedAt: number;
}

/**
 * The agents module asks before it starts a run on a tool, on this machine
 * (it starts its runs here). AiToolsService has it. Nothing here waits for a
 * command: checks run in the background, and their last answer is used.
 */
export interface ToolReadiness {
  /**
   * A refusal when the tool's last check here says it is signed out; null
   * when it is signed in, when it can't tell, when it was never checked or
   * its answer is stale (a check then starts in the background), and for a
   * tool without a check.
   */
  signInRefusal(tool: string, config: ProjectConfig): SignInRefusal | null;
  /** Start a background check of the tool here when its state is not fresh (a run on it was just requested) */
  prime(tool: string, config: ProjectConfig): void;
  /** The tool's fresh sign-in state here, without checking (null: never checked, stale, or no check) */
  lastSignIn(tool: string, config: ProjectConfig): SignInState | null;
  /** Check the tool again now, in the background (the owner says they signed in); its last state stands until then */
  recheck(tool: string, config: ProjectConfig): void;
}
