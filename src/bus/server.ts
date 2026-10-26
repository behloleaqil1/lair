/**
 * lair-bus MCP Server
 *
 * A stdio MCP server providing structured messaging for AI agent fleets.
 * Tools: whoami, claim, release, report, inbox, ack, send, board
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  type WhoamiOutput,
  type ClaimOutput,
  type ReleaseOutput,
  type ReportOutput,
  type InboxMessage,
  type AckOutput,
  type SendOutput,
  type BoardOutput,
  type BusProjectConfig,
  type ReportKind,
} from "./types.js";
import { BusStorage } from "./storage.js";
import { Mirror } from "./mirror.js";
import { LAIR_VERSION } from "../shared/version.js";

// Special agent IDs
const ORCHESTRATOR_ID = "orchestrator";
const OWNER_ID = "owner";

/**
 * Create and configure the MCP server
 */
export function createBusServer(
  config: BusProjectConfig,
  storage: BusStorage,
  agentId: string,
): McpServer {
  const mirror = new Mirror(config);

  const server = new McpServer({
    name: "lair-bus",
    version: LAIR_VERSION,
  });

  // ============ whoami ============
  server.tool(
    "whoami",
    "Get current agent identity and claims",
    {},
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      // Update agent's last seen
      storage.upsertAgent(agentId);

      const agent = storage.getAgent(agentId);
      const claims = storage.getAgentClaims(agentId);

      const output: WhoamiOutput = {
        agent_id: agentId,
        display_name: agent?.display_name ?? null,
        claims,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  // ============ claim ============
  server.tool(
    "claim",
    "Claim ownership of a task (atomic, one owner per task)",
    {
      task: z.string().min(1, "Task name required"),
    },
    async (args): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const { task } = args;
      const result = storage.tryClaim(task, agentId);

      const output: ClaimOutput = {
        success: result.success,
        task,
        owner: result.owner,
        message: result.success
          ? `Task "${task}" claimed by ${agentId}`
          : `Task "${task}" already owned by ${result.owner}`,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  // ============ release ============
  server.tool(
    "release",
    "Release ownership of a task",
    {
      task: z.string().min(1, "Task name required"),
    },
    async (args): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const { task } = args;
      const released = storage.releaseClaim(task, agentId);

      const output: ReleaseOutput = {
        success: released,
        task,
        message: released
          ? `Task "${task}" released`
          : `You don't own task "${task}"`,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  // ============ report ============
  server.tool(
    "report",
    "Report task status (WAITING, DONE, BLOCKED, PROGRESS, TICK)",
    {
      kind: z.enum(["WAITING", "DONE", "BLOCKED", "PROGRESS", "TICK"]),
      task: z.string().min(1, "Task name required"),
      summary: z.string().min(1, "Summary required"),
      gate_id: z.string().optional(),
      pr: z.number().int().positive().optional(),
      sha: z.string().optional(),
    },
    async (args): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const { kind, task, summary, gate_id, pr, sha } = args;
      const now = new Date().toISOString();

      // Create the report in the database
      const id = storage.createReport(
        agentId,
        kind as ReportKind,
        task,
        summary,
        gate_id,
        pr,
        sha,
      );

      // Mirror to text files
      const mirrored = mirror.mirrorReport(
        agentId,
        kind as ReportKind,
        task,
        summary,
        now,
        gate_id,
        pr,
        sha,
      );

      // Wake the orchestrator if needed
      if (mirror.shouldWake(kind as ReportKind)) {
        mirror.touchWake();
      }

      const output: ReportOutput = {
        success: true,
        id,
        mirrored_to: mirrored,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  // ============ inbox ============
  server.tool(
    "inbox",
    "Get unread messages for this agent",
    {},
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const messages = storage.getUnreadMessages(agentId);

      const output: InboxMessage[] = messages.map((m) => ({
        id: m.id,
        from: m.from_id,
        text: m.text,
        priority: m.priority,
        sent_at: m.created_at,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  // ============ ack ============
  server.tool(
    "ack",
    "Acknowledge a message",
    {
      message_id: z.string().min(1, "Message ID required"),
      note: z.string().optional(),
    },
    async (args): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const { message_id, note } = args;
      const acked = storage.ackMessage(message_id, agentId, note);

      const output: AckOutput = {
        success: acked,
        message_id,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  // ============ send ============
  server.tool(
    "send",
    "Send a message to another agent, orchestrator, or owner",
    {
      to: z.string().min(1, "Recipient required"),
      text: z.string().min(1, "Message text required"),
      priority: z.number().int().min(1).max(10).optional(),
    },
    async (args): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const { to, text, priority } = args;

      // Enforce send restrictions: agents can only send to orchestrator or owner
      const isOrchestratorOrOwner = agentId === ORCHESTRATOR_ID || agentId === OWNER_ID;
      const toOrchestratorOrOwner = to === ORCHESTRATOR_ID || to === OWNER_ID;

      if (!isOrchestratorOrOwner && !toOrchestratorOrOwner) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "Agents can only send to orchestrator or owner",
              }),
            },
          ],
        };
      }

      const now = new Date().toISOString();
      const messageId = storage.sendMessage(agentId, to, text, priority ?? 5);

      // Mirror to text files
      mirror.mirrorMessage(messageId, agentId, to, text, now);

      // Wake the orchestrator if needed
      if (mirror.shouldWake(undefined, to, agentId)) {
        mirror.touchWake();
      }

      const output: SendOutput = {
        success: true,
        message_id: messageId,
        to,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  // ============ board ============
  server.tool(
    "board",
    "Get the current board state: tasks, owners, and last reports",
    {},
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const claims = storage.getAllActiveClaims();
      const reports = storage.getLatestReportsByTask();
      const agents = storage.getAllAgents();

      // Build task list with owners and last reports
      const taskSet = new Set<string>();
      claims.forEach((c) => taskSet.add(c.task));
      reports.forEach((_, task) => taskSet.add(task));

      const tasks = Array.from(taskSet).map((task) => {
        const claim = claims.find((c) => c.task === task);
        const report = reports.get(task);

        return {
          task,
          owner: claim?.owner_id ?? null,
          last_report: report
            ? {
                kind: report.kind,
                summary: report.summary,
                time: report.created_at,
                gate_id: report.gate_id ?? undefined,
                pr: report.pr ?? undefined,
                sha: report.sha ?? undefined,
              }
            : null,
        };
      });

      // Build agent list with claims
      const agentList = agents.map((a) => ({
        id: a.id,
        display_name: a.display_name,
        claims: claims.filter((c) => c.owner_id === a.id).map((c) => c.task),
        last_seen: a.last_seen,
      }));

      const output: BoardOutput = {
        tasks,
        agents: agentList,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  return server;
}

/**
 * Run the MCP server over stdio
 */
export async function runServer(
  config: BusProjectConfig,
  agentId: string,
  dataDir: string,
): Promise<void> {
  // Initialize storage
  const storage = new BusStorage(config.name, dataDir);
  await storage.init();

  // Register the agent
  storage.upsertAgent(agentId);

  // Create and run the server
  const server = createBusServer(config, storage, agentId);
  const transport = new StdioServerTransport();

  // Handle cleanup on exit
  process.on("SIGINT", () => {
    storage.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    storage.close();
    process.exit(0);
  });

  await server.connect(transport);
}
