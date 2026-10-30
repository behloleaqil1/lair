/**
 * Cloud providers (docs/design/cloud-runners.md §2). A provider is one
 * account: for AWS EC2, one named profile from the AWS config files, the
 * only source of credentials (never the project YAML, never the server's
 * environment). It describes, starts and stops a machine's tagged instance
 * and reads the account's cost.
 *
 * The provider talks to AWS only through AwsClients, the AWS SDK's EC2 and
 * Cost Explorer clients: tests fake those clients (a remote API) and run
 * this code as it is.
 */
import {
  DescribeInstancesCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  type Instance,
} from "@aws-sdk/client-ec2";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { fromIni } from "@aws-sdk/credential-providers";
import type { CloudPowerState } from "../../shared/cloud-types.js";
import type { CloudMachineSettings } from "./config.js";

export type PowerState = Exclude<CloudPowerState, "unknown">;

const POWER_STATES: ReadonlySet<string> = new Set<PowerState>([
  "pending",
  "running",
  "stopping",
  "stopped",
  "shutting-down",
  "terminated",
]);
/** States in which the instance is not billed for compute */
export const STOPPED_STATES: ReadonlySet<PowerState> = new Set<PowerState>(["stopped", "terminated"]);

const DAY_MS = 86_400_000;
/** Cost Explorer pages read for one reading at most (a monthly reading of a year is one page) */
const MAX_COST_PAGES = 10;
/** The longest provider text kept in an error */
const MAX_TEXT = 300;

/** Provider text that names the account: ARNs (any partition), access key ids, 12-digit account ids */
const ARN = /\barn:aws[a-z-]*:[^\s"'`,;()<>]*/gi;
const ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const ACCOUNT_ID = /(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/g;

export interface MachineDescription {
  state: PowerState;
  /** The last launch (start), from the provider */
  launchedAt: number | null;
  /** The last stop, from the provider; null while running, or when the provider does not say */
  stoppedAt: number | null;
}

/** Cost before credits and refunds since the period start, or unknown (no data yet) */
export type SpendReading = { kind: "amount"; amount: number } | { kind: "unknown"; reason: string };

export interface CloudProvider {
  describe(machine: CloudMachineSettings): Promise<MachineDescription>;
  /**
   * Starts a stopped machine; a running or pending one is left as it is. Returns the state after.
   * Guard-only: CloudMachines.startMachine() is its one caller, after the money guard allowed the
   * start. Nothing else calls it, and the barrel (index.ts) exports no provider to call it on.
   */
  start(machine: CloudMachineSettings): Promise<PowerState>;
  /** Stops a running or pending machine; a stopped one is left as it is. Returns the state after. */
  stop(machine: CloudMachineSettings): Promise<PowerState>;
  /** The account's spend over the period's days up to today (YYYY-MM-DD, both included) */
  spend(period: { start: string; end: string }, now: number): Promise<SpendReading>;
}

/** The SDK clients a provider uses: the boundary tests fake. */
export interface AwsClients {
  ec2(region: string): Pick<EC2Client, "send">;
  costExplorer(): Pick<CostExplorerClient, "send">;
}

/**
 * The real clients for one profile. Credentials come from that profile
 * alone (fromIni: the shared config and credentials files, including SSO,
 * role and credential_process profiles), so keys in the environment or an
 * instance role are never picked up instead.
 */
export function sdkClients(profile: string, timeoutMs: number): AwsClients {
  const credentials = fromIni({ profile });
  const requestHandler = { connectionTimeout: Math.min(timeoutMs, 10_000), requestTimeout: timeoutMs };
  const ec2 = new Map<string, EC2Client>();
  let ce: CostExplorerClient | null = null;
  return {
    ec2(region) {
      let client = ec2.get(region);
      if (!client) {
        client = new EC2Client({ region, credentials, requestHandler, maxAttempts: 2 });
        ec2.set(region, client);
      }
      return client;
    },
    // Cost Explorer has one endpoint, in us-east-1
    costExplorer: () => (ce ??= new CostExplorerClient({ region: "us-east-1", credentials, requestHandler, maxAttempts: 2 })),
  };
}

/**
 * Provider text as Lair keeps, logs and shows it: ARNs, access key ids and
 * account ids hidden (an AWS error such as AccessDenied names the account
 * and the role), at most 300 characters.
 */
export function providerText(value: unknown): string {
  return String(value)
    .slice(0, 8192)
    .replace(ARN, "arn:(hidden)")
    .replace(ACCESS_KEY_ID, "(key id hidden)")
    .replace(ACCOUNT_ID, "(account id hidden)")
    .slice(0, MAX_TEXT);
}

function text(value: unknown): string {
  return providerText(value);
}

function powerState(value: unknown): PowerState | null {
  return typeof value === "string" && POWER_STATES.has(value) ? (value as PowerState) : null;
}

/** "User initiated (2027-01-05 14:02:11 GMT)": when the instance last changed state */
export function transitionTime(reason: string | undefined): number | null {
  const match = /\((\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT\)/.exec((reason ?? "").slice(0, MAX_TEXT));
  if (!match) return null;
  const [y, mo, d, h, mi, s] = match.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(ms) ? ms : null;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** AWS EC2: one profile's instances, by id and tag, in any region. */
export class AwsEc2Provider implements CloudProvider {
  constructor(private clients: AwsClients) {}

  /**
   * The instance with this id AND the machine's tag: an instance without the
   * tag is not found, so a wrong id in the config never reaches another
   * machine (the runtime credentials are limited to the tag as well).
   */
  async describe(machine: CloudMachineSettings): Promise<MachineDescription> {
    const out = await this.clients.ec2(machine.region).send(
      new DescribeInstancesCommand({
        InstanceIds: [machine.instanceId],
        Filters: [{ Name: `tag:${machine.tagKey}`, Values: [machine.tagValue] }],
      }),
    );
    const found: Instance[] = (out.Reservations ?? [])
      .flatMap((r) => r.Instances ?? [])
      .filter(
        (i) =>
          i.InstanceId === machine.instanceId &&
          (i.Tags ?? []).some((t) => t.Key === machine.tagKey && t.Value === machine.tagValue),
      );
    if (found.length !== 1) {
      throw new Error(
        `${machine.instanceId} with tag ${machine.tagKey}=${machine.tagValue} not found in ${machine.region}`,
      );
    }
    const instance = found[0];
    const state = powerState(instance.State?.Name);
    if (!state) throw new Error(`${machine.instanceId}: unknown state ${text(instance.State?.Name)}`);
    const launch = instance.LaunchTime instanceof Date ? instance.LaunchTime.getTime() : NaN;
    return {
      state,
      launchedAt: Number.isFinite(launch) ? launch : null,
      stoppedAt: STOPPED_STATES.has(state) ? transitionTime(instance.StateTransitionReason) : null,
    };
  }

  async start(machine: CloudMachineSettings): Promise<PowerState> {
    const now = await this.describe(machine);
    if (now.state === "running" || now.state === "pending") return now.state;
    if (now.state !== "stopped") throw new Error(`${machine.id} is ${now.state}: it can't be started now`);
    const out = await this.clients
      .ec2(machine.region)
      .send(new StartInstancesCommand({ InstanceIds: [machine.instanceId] }));
    const after = (out.StartingInstances ?? []).find((i) => i.InstanceId === machine.instanceId);
    return powerState(after?.CurrentState?.Name) ?? "pending";
  }

  async stop(machine: CloudMachineSettings): Promise<PowerState> {
    const now = await this.describe(machine);
    if (now.state !== "running" && now.state !== "pending") return now.state;
    const out = await this.clients
      .ec2(machine.region)
      .send(new StopInstancesCommand({ InstanceIds: [machine.instanceId] }));
    const after = (out.StoppingInstances ?? []).find((i) => i.InstanceId === machine.instanceId);
    return powerState(after?.CurrentState?.Name) ?? "stopping";
  }

  /**
   * Unblended cost with credits and refunds left out (the cost before them),
   * summed over the period's months up to today. A new account has no Cost
   * Explorer data for up to a day: that is "unknown", not an error.
   */
  async spend(period: { start: string; end: string }, now: number): Promise<SpendReading> {
    // End is exclusive: tomorrow, or the day after the period's last day
    const end = day(Math.min(Date.parse(`${period.end}T00:00:00Z`) + DAY_MS, Math.floor(now / DAY_MS) * DAY_MS + DAY_MS));
    if (end <= period.start) return { kind: "amount", amount: 0 };
    let total = 0;
    let read = false;
    let token: string | undefined;
    let pages = 0;
    try {
      do {
        const out = await this.clients.costExplorer().send(
          new GetCostAndUsageCommand({
            TimePeriod: { Start: period.start, End: end },
            Granularity: "MONTHLY",
            Metrics: ["UnblendedCost"],
            Filter: { Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund"] } } },
            NextPageToken: token,
          }),
        );
        for (const result of out.ResultsByTime ?? []) {
          const cost = result.Total?.UnblendedCost;
          if (cost?.Amount === undefined) continue;
          if (cost.Unit !== undefined && cost.Unit !== "USD") throw new Error(`cost is in ${text(cost.Unit)}, not USD`);
          const amount = Number(cost.Amount);
          if (!Number.isFinite(amount)) throw new Error(`cost amount ${text(cost.Amount)} is not a number`);
          total += amount;
          read = true;
        }
        token = out.NextPageToken;
        pages += 1;
      } while (token && pages < MAX_COST_PAGES);
    } catch (e) {
      if ((e as { name?: unknown } | null)?.name === "DataUnavailableException") {
        return { kind: "unknown", reason: "the provider has no cost data yet (a new account has none for up to a day)" };
      }
      throw e;
    }
    if (token) throw new Error(`more than ${MAX_COST_PAGES} pages of cost data`);
    if (!read) return { kind: "unknown", reason: "the provider returned no cost for the period" };
    return { kind: "amount", amount: total };
  }
}
