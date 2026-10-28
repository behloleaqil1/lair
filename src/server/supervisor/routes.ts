/**
 * The supervisor's routes.
 *
 * The owner's, from a signed-in dashboard (requireOwner(), before anything
 * is read; /api/health/diagnostics and /api/supervisor are in
 * OWNER_ONLY_PREFIXES):
 *
 *   GET  /api/health/diagnostics?project=      the self-checks' latest results
 *   POST /api/supervisor/tokens {ttl_minutes?, label?}
 *                                              an ops token for an interactive session (shown once)
 *   GET  /api/supervisor/tokens                the live tokens (never the tokens themselves)
 *   POST /api/supervisor/tokens/:id/revoke     end one
 *   GET  /api/supervisor/audit?limit=&token=   the ops API's audit trail
 *   POST /api/supervisor/ask {project?, question, conversationId?}
 *                                              a question for a supervisor run (202: the conversation)
 *   GET  /api/supervisor/chat?project=         whether questions are on, the bounds, the conversations
 *   GET  /api/supervisor/conversations/:id     one conversation: its questions, answers and evidence
 *   GET  /api/supervisor/digest?project=       the latest daily digest
 *
 * The ops API, for an AI supervisor: an ops token (Authorization: Bearer),
 * never the owner's session. Read tools only, and the answer to the run's
 * own question. Every call is audited.
 *
 *   POST /api/ops/call {tool, args}            one tool of ops-catalog.ts
 *   POST /api/ops/answer {conversation, answer, evidence?}
 *                                              the run's answer to its question, once (a run token only)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { projectNameError } from "../config.js";
import type { HumanAuth } from "../human-auth/index.js";
import { rejectCrossSiteRequests } from "../origin.js";
import type { OpsCallOutcome } from "../../shared/supervisor-types.js";
import { ChatError, type SupervisorChat } from "./chat.js";
import { opsTool } from "./ops-catalog.js";
import { OpsError, parseArgs, runOpsTool, type OpsSources } from "./ops-tools.js";
import { bounded, redactText } from "./redact.js";
import type { Supervisor } from "./service.js";
import type { SupervisorStore } from "./store.js";
import { MAX_TTL_MS, type OpsToken, type OpsTokens } from "./tokens.js";

export interface SupervisorRoutesOptions {
  supervisor: Supervisor;
  tokens: OpsTokens;
  store: SupervisorStore;
  auth: HumanAuth;
  ops: OpsSources;
  /** Questions and digests answered by supervisor runs */
  chat?: SupervisorChat;
  defaultProject(): string;
  /** For tests: where projects are (projectNameError's projectsDir) */
  projectsDir?: string;
  clock?: () => number;
  /** A tool still running after this long answers 504 (default 20 s) */
  callTimeoutMs?: number;
}

/** What one call may return, as JSON */
export const MAX_RESULT_BYTES = 256 * 1024;
/** Calls per token per minute */
export const MAX_CALLS_PER_MINUTE = 120;
/** Calls with a token Lair doesn't know that are audited per minute (the rest are only refused) */
const MAX_UNKNOWN_AUDITS_PER_MINUTE = 30;

const ok = <T>(data: T) => ({ success: true, data, timestamp: new Date().toISOString() });

function refuse(reply: FastifyReply, statusCode: number, error: string) {
  return reply.code(statusCode).send({ success: false, error, timestamp: new Date().toISOString() });
}

function bearer(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(\S{1,200})$/i.exec(header.trim());
  return match?.[1];
}

class TimedOut extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimedOut()), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function registerSupervisorRoutes(fastify: FastifyInstance, options: SupervisorRoutesOptions): Promise<void> {
  const { supervisor, tokens, store, auth } = options;
  const clock = options.clock ?? Date.now;

  // ============ THE OWNER'S ============
  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    // Before anything is read: a refused request learns nothing
    app.addHook("onRequest", auth.requireOwner("Only the owner can read Lair's diagnostics and its ops tokens, from the dashboard signed in as the owner"));

    app.get<{ Querystring: { project?: string } }>("/api/health/diagnostics", async (request, reply) => {
      const project = request.query.project;
      if (project !== undefined && project !== "") {
        const problem = projectNameError(project, options.projectsDir);
        if (problem) return refuse(reply, 400, problem);
      }
      return reply.send(ok(supervisor.diagnostics(project || undefined)));
    });

    app.post("/api/supervisor/tokens", { bodyLimit: 4096 }, async (request, reply) => {
      const body = (request.body ?? {}) as { ttl_minutes?: unknown; label?: unknown };
      const ttl = body.ttl_minutes ?? 60;
      if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 5 || ttl * 60_000 > MAX_TTL_MS) {
        return refuse(reply, 400, `ttl_minutes: a whole number from 5 to ${MAX_TTL_MS / 60_000}`);
      }
      const label = typeof body.label === "string" && body.label.trim() !== "" ? redactText(body.label.trim(), 80) : "owner session";
      const minted = tokens.mintSession(ttl * 60_000, label);
      store.audit({ at: clock(), tokenId: minted.info.id, who: "owner", tool: "(token minted)", args: `ttl_minutes=${ttl}, label=${label}`, outcome: "ok", durationMs: 0 });
      return reply.code(201).send(ok(minted));
    });

    app.get("/api/supervisor/tokens", async (_request, reply) => reply.send(ok(tokens.list())));

    app.post<{ Params: { id: string } }>("/api/supervisor/tokens/:id/revoke", { bodyLimit: 1024 }, async (request, reply) => {
      const id = request.params.id;
      if (!/^[0-9a-f-]{36}$/.test(id)) return refuse(reply, 400, "Invalid token id");
      if (!tokens.revoke(id)) return refuse(reply, 404, "No live token with this id");
      store.audit({ at: clock(), tokenId: id, who: "owner", tool: "(token revoked)", args: "", outcome: "ok", durationMs: 0 });
      return reply.send(ok({ id, revoked: true }));
    });

    app.get<{ Querystring: { limit?: string; token?: string } }>("/api/supervisor/audit", async (request, reply) => {
      const limit = Number(request.query.limit ?? 100);
      const token = request.query.token;
      if (token !== undefined && !/^[0-9a-f-]{36}$/.test(token)) return refuse(reply, 400, "Invalid token id");
      return reply.send(ok(store.list(Number.isFinite(limit) ? limit : 100, token)));
    });

    // ---- Questions and digests (S1-2) ----

    /** The project a request names, checked; or the default project */
    const projectOf = (value: unknown, reply: FastifyReply): string | null => {
      const project = typeof value === "string" && value !== "" ? value : options.defaultProject();
      const problem = projectNameError(project, options.projectsDir);
      if (problem) {
        void refuse(reply, 400, problem);
        return null;
      }
      return project;
    };
    const chat = options.chat;
    const noChat = (reply: FastifyReply) => refuse(reply, 503, "The supervisor's runs don't run in this server");

    app.post("/api/supervisor/ask", { bodyLimit: 16 * 1024 }, async (request, reply) => {
      if (!chat) return noChat(reply);
      const body = (request.body ?? {}) as { project?: unknown; question?: unknown; conversationId?: unknown };
      const project = projectOf(body.project, reply);
      if (project === null) return reply;
      try {
        const conversation = await chat.ask({ project, question: body.question, conversationId: body.conversationId });
        return reply.code(202).send(ok({ conversation }));
      } catch (e) {
        if (e instanceof ChatError) return refuse(reply, e.statusCode, e.message);
        throw e;
      }
    });

    app.get<{ Querystring: { project?: string } }>("/api/supervisor/chat", async (request, reply) => {
      if (!chat) return noChat(reply);
      const project = projectOf(request.query.project, reply);
      if (project === null) return reply;
      return reply.send(ok(chat.status(project)));
    });

    app.get<{ Params: { id: string } }>("/api/supervisor/conversations/:id", async (request, reply) => {
      if (!chat) return noChat(reply);
      const view = chat.conversation(request.params.id);
      if (!view) return refuse(reply, 404, "No such conversation");
      return reply.send(ok(view));
    });

    app.get<{ Querystring: { project?: string } }>("/api/supervisor/digest", async (request, reply) => {
      if (!chat) return noChat(reply);
      const project = projectOf(request.query.project, reply);
      if (project === null) return reply;
      return reply.send(ok(chat.digest(project)));
    });
  });

  // ============ THE OPS API ============
  const verified = new WeakMap<FastifyRequest, OpsToken>();
  const calls = new Map<string, number[]>();
  let unknownAudits: number[] = [];

  await fastify.register(async (app) => {
    app.addHook("onRequest", rejectCrossSiteRequests);
    // The token, before the body is read: an ops token only, never an owner session
    app.addHook("onRequest", async (request, reply) => {
      const record = tokens.verify(bearer(request.headers.authorization));
      if (!record) {
        const now = clock();
        unknownAudits = unknownAudits.filter((t) => now - t < 60_000);
        if (unknownAudits.length < MAX_UNKNOWN_AUDITS_PER_MINUTE) {
          unknownAudits.push(now);
          store.audit({ at: now, tokenId: "-", who: "(no valid token)", tool: "-", args: "", outcome: "refused", detail: "no valid ops token", durationMs: 0 });
        }
        return reply
          .code(401)
          .header("www-authenticate", "Bearer")
          .send({ success: false, error: "An ops token is needed (Authorization: Bearer <token>): one the server minted for this run, still alive", timestamp: new Date().toISOString() });
      }
      verified.set(request, record);
    });

    app.post("/api/ops/call", { bodyLimit: 16 * 1024 }, async (request, reply) => {
      const record = verified.get(request)!;
      const started = clock();
      const body = (request.body ?? {}) as { tool?: unknown; args?: unknown };
      const tool = typeof body.tool === "string" ? body.tool.slice(0, 80) : "";
      let argsText = redactText(JSON.stringify(body.args ?? {}) ?? "{}", 300);
      const audit = (outcome: OpsCallOutcome, detail: string | null) =>
        store.audit({ at: started, tokenId: record.id, who: record.label, tool: tool || "-", args: argsText, outcome, detail, durationMs: clock() - started });
      const refused = (code: number, why: string) => {
        audit("refused", why);
        return refuse(reply, code, why);
      };

      const now = clock();
      // Tokens with no call in the last minute (ended ones among them) are forgotten
      for (const [id, times] of calls) if (id !== record.id && times.every((t) => now - t >= 60_000)) calls.delete(id);
      const recent = (calls.get(record.id) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= MAX_CALLS_PER_MINUTE) return refused(429, `more than ${MAX_CALLS_PER_MINUTE} calls a minute with this token: slow down`);
      recent.push(now);
      calls.set(record.id, recent);

      const spec = opsTool(tool);
      if (!spec) return refused(404, `unknown tool ${redactText(tool, 80) || "(none)"}: only read tools exist (status.<module>, events.query, decisions.list, runs.get, logs.tail, gates.result, triage.record, placement.status, config.get, diagnostics.run)`);
      const parsed = parseArgs(spec, body.args);
      if (!parsed.ok) return refused(400, `invalid arguments: ${redactText(parsed.error, 300)}`);
      argsText = redactText(JSON.stringify(parsed.args), 300);
      // A token that reads one project (a run's) defaults to it; one that reads every project, to the default project
      const project =
        typeof parsed.args.project === "string"
          ? parsed.args.project
          : record.projects !== "*" && record.projects.length === 1
            ? record.projects[0]
            : options.defaultProject();
      const problem = projectNameError(project, options.projectsDir);
      if (problem) return refused(400, problem);
      if (record.projects !== "*" && !record.projects.includes(project)) {
        return refused(403, `this token reads ${record.projects.join(", ")} only`);
      }

      try {
        const caller = { allProjects: record.projects === "*", projectGiven: typeof parsed.args.project === "string" };
        const result = await within(runOpsTool(spec, project, parsed.args, options.ops, caller), options.callTimeoutMs ?? 20_000);
        const out = bounded(result, MAX_RESULT_BYTES);
        audit("ok", out.truncated ? "the answer was cut to fit" : null);
        return reply.send(ok({ tool, project, truncated: out.truncated, result: out.value }));
      } catch (e) {
        if (e instanceof OpsError) return refused(e.statusCode, redactText(e.message, 300));
        if (e instanceof TimedOut) {
          audit("error", "timed out");
          return refuse(reply, 504, `${tool} took longer than ${Math.round((options.callTimeoutMs ?? 20_000) / 1000)} s`);
        }
        request.log.error({ err: e, tool }, "ops: a tool failed");
        audit("error", "the tool failed");
        return refuse(reply, 500, "The tool failed: the server log says why");
      }
    });

    // The run's answer to its own question (`lair supervisor answer`): the chat checks the token is that run's
    app.post("/api/ops/answer", { bodyLimit: 256 * 1024 }, async (request, reply) => {
      const record = verified.get(request)!;
      const started = clock();
      const body = (request.body ?? {}) as { conversation?: unknown; answer?: unknown; evidence?: unknown };
      const conversation = typeof body.conversation === "string" ? redactText(body.conversation, 64) : "-";
      const audit = (outcome: OpsCallOutcome, detail: string | null) =>
        store.audit({ at: started, tokenId: record.id, who: record.label, tool: "(answer)", args: `conversation=${conversation}`, outcome, detail, durationMs: clock() - started });
      if (!options.chat) {
        audit("refused", "no supervisor runs here");
        return refuse(reply, 503, "The supervisor's runs don't run in this server");
      }
      try {
        const result = await options.chat.answer({ token: record, conversation: body.conversation, answer: body.answer, evidence: body.evidence });
        audit("ok", null);
        return reply.send(ok(result));
      } catch (e) {
        if (e instanceof ChatError) {
          audit("refused", redactText(e.message, 300));
          return refuse(reply, e.statusCode, e.message);
        }
        request.log.error({ err: e }, "ops: an answer could not be taken");
        audit("error", "the answer could not be taken");
        return refuse(reply, 500, "The answer could not be taken: the server log says why");
      }
    });
  });
}
