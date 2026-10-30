/** The two boundaries of the plan sandbox: the cloud's token service and the isolated process runner */

export interface PlanCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO time the credentials stop working */
  expiresAt: string;
}

/** Issues the short-lived credentials of the read-only plan role (AWS STS AssumeRole) */
export interface PlanCredentialIssuer {
  issue(request: { roleArn: string; externalId?: string; sessionName: string; seconds: number; region: string }): Promise<PlanCredentials>;
}

/** What the runner is told to start; it holds nothing else of the host's */
export interface SandboxSpec {
  image: string;
  argv: string[];
  /** Private copy of the code: the working directory */
  workdir: string;
  /** Provider mirror, mounted read-only */
  pluginDir: string;
  /** The whole environment of the process; nothing is inherited from Lair */
  env: Record<string, string>;
  /** Hosts the process may reach; with no `network` it reaches nothing */
  egress: { hosts: string[]; network?: string };
  timeoutMs: number;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxSpawner {
  run(spec: SandboxSpec): Promise<SandboxResult>;
}
