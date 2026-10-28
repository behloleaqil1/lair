/**
 * The AI tools API (src/server/ai/): which tools are installed and signed in
 * on each machine, and the models each one offers. See docs/design/ai-roles.md.
 */
import type { ToolModel } from "./types.js";

/** Where a tool's model list came from: its list command, the preset's known list, or nowhere */
export type ModelsSource = "cmd" | "preset" | "none";

/** GET /api/ai/models?tool=<id>: the models the tool offers on a machine. */
export interface AiModelsView {
  tool: string;
  machine: string;
  models: Required<Pick<ToolModel, "id" | "label" | "notes" | "default">>[];
  source: ModelsSource;
  /** When the list was read (ISO); null when there is none */
  fetchedAt: string | null;
  /** Why the list command gave no list (the known list, if any, is shown instead) */
  error?: string;
}

/** A tool's sign-in state on a machine. */
export type SignInState = "signed_in" | "signed_out" | "unknown";

export interface ToolMachineStatus {
  machine: string;
  /** The tool's program is on PATH there; null when that couldn't be told (the machine didn't answer) */
  installed: boolean | null;
  /** Where the program is, when found */
  path: string | null;
  /** Its version line, when it prints one cheaply */
  version: string | null;
  signIn: {
    state: SignInState;
    /** "signed in as ...": the check's first line, when signed in */
    as: string | null;
    /** What was found, in words */
    detail: string;
    /** The exact command to run in a terminal on that machine to sign in (from the preset), or null */
    fix: string | null;
  };
  /** When this was checked (ISO) */
  checkedAt: string;
}

export interface ToolStatusView {
  id: string;
  name: string;
  experimental: boolean;
  /** The program its start command runs, or null when it can't be told */
  program: string | null;
  /** The tool has a sign-in check (auth_check_cmd) */
  signInCheck: boolean;
  /** The tool has a models list command (models_cmd), or a known list */
  modelsCmd: boolean;
  knownModels: number;
  /** Named by a profile, a dragon or a fallback of the project */
  inUse: boolean;
  machines: ToolMachineStatus[];
}

/** GET /api/ai/tools: every tool the project can use, per machine. */
export interface AiToolsView {
  project: string;
  tools: ToolStatusView[];
  /** Machines that were not checked, and why (a remote machine is checked only for the tools in use) */
  notes: string[];
}
