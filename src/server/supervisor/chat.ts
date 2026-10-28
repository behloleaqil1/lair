/**
 * The supervisor's runs, part 2 (S1-2, docs/design/supervisor.md): the
 * owner's questions from the dashboard, and the daily digest, each answered
 * by a supervisor run the agents module starts.
 *
 * - ask(): POST /api/supervisor/ask (owner only). A question starts or
 *   continues a conversation in data/supervisor.db, and one run of the
 *   supervisor agent (supervisor.agent, else the dragon on ai.roles.supervise's
 *   first profile), requested in-process like any module's run, so claims,
 *   locks, budgets, recovery and failover apply. Its prompt is the template
 *   plus the context Lair builds (chat-prompt.ts). Its environment gets a
 *   run token for the ops API (LAIR_OPS_TOKEN: minted for this run and
 *   bound to it, ending with it), LAIR_URL and LAIR_SUPERVISOR_CONVERSATION.
 *   The token is never in the prompt, the store or a log.
 * - answer(): POST /api/ops/answer, under that run token only, from
 *   `lair supervisor answer`. It is taken once per question, only while the
 *   run is active (the token checks that), and only from the run that was
 *   asked. The answer and its evidence are cleaned (answers.ts).
 * - check(): a question whose run ended without an answer (exited, failed
 *   over, recovered into a new run, stopped) or that reached
 *   answer_timeout_minutes is closed as "no answer" with the reason, its
 *   token ends, and a run still going on its task is stopped (its claim
 *   released). Nothing is retried: the owner asks again.
 * - digestTick(): with supervisor.digest.enabled, once a day at
 *   supervisor.digest.time (local), a digest run; its answer is kept as the
 *   day's digest, and with notifications on, one notice says it is ready.
 * - Bounds (supervisor.chat): max_runs_per_day and min_interval_seconds for
 *   every supervisor run of the project, questions and digests alike;
 *   max_conversation_turns; answer_timeout_minutes. The agents module's
 *   budgets apply on top.
 *
 * Restarts: tokens live in memory only, so a question still pending when
 * Lair starts can't be answered any more. recover() closes it as "no
 * answer" and stops its run.
 */
import { existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import type { ProjectConfig } from "../../shared/types.js";
import type { AgentRunView } from "../../shared/agents-types.js";
import type { Decision } from "../../shared/decision-types.js";
import type {
  ChatStatusView,
  ConversationKind,
  ConversationView,
  DigestView,
} from "../../shared/supervisor-types.js";
import { plainText, type LinkPolicy } from "../../shared/safe-markdown.js";
import { isActive, type AgentRun } from "../agents/types.js";
import { readPromptFile } from "../agents/prompts.js";
import type { DecisionProducer } from "../decisions/types.js";
import type { ListOptions } from "../decisions/store.js";
import { getPromptsDir } from "../routes/controls.js";
import { supervisorAgent, type ChatSettings, type SupervisorSettings } from "./config.js";
import { buildSupervisorPrompt } from "./chat-prompt.js";
import { sanitizeAnswer, sanitizeEvidence } from "./answers.js";
import { NOTICE_MODULE } from "./notices.js";
import { redactText } from "./redact.js";
import type { Supervisor } from "./service.js";
import { turnView, type StoredConversation, type StoredTurn, type SupervisorStore } from "./store.js";
import type { OpsToken, OpsTokens } from "./tokens.js";

export const MAX_QUESTION = 2000;
/** How often check() and digestTick() run on their own */
export const CHAT_CHECK_MS = 15_000;
/** A digest that could not start yet (the agent busy, too soon after another run) is tried again after this */
export const DIGEST_RETRY_MS = 60_000;
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TEMPLATE_CHARS = 100_000;
/** How long the chat's status keeps the supervisor agent it found (a reload of the project forgets it at once) */
export const AGENT_CACHE_MS = 30_000;

/** Lair's own prompt, at the repository's top level (three levels up from src/ and from dist/) */
export const DEFAULT_PROMPT_PATH = fileURLToPath(new URL("../../../prompts/supervisor.md", import.meta.url));

/** How a run calls Lair's CLI: the built one next to this server when there is one, else `lair` on PATH */
function defaultCli(): string {
  const built = fileURLToPath(new URL("../../cli/lair.js", import.meta.url));
  return existsSync(built) ? `node ${JSON.stringify(built)}` : "lair";
}

const iso = (ms: number) => new Date(ms).toISOString();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const oneLine = (text: string, max = 300) => redactText(text.replace(/\s+/g, " ").trim(), max);
const pad = (n: number) => String(n).padStart(2, "0");

/** The local date of `ms` (YYYY-MM-DD): a digest is one per local day. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `hhmm` (HH:MM) on the local day of `ms`, in ms. */
export function localTimeOn(ms: number, hhmm: string): number {
  const d = new Date(ms);
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
}

/** The repository's web address, the one host answers may link to (GitHub, or the review module's API host). */
export function repoWebUrl(config: ProjectConfig): string | null {
  const repo = config.github;
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo.includes("..")) return null;
  let web = "https://github.com";
  const review = config.review as unknown;
  const api = typeof review === "object" && review !== null ? (review as { api_url?: unknown }).api_url : undefined;
  if (typeof api === "string") {
    try {
      const url = new URL(api);
      if (url.protocol === "https:" && url.hostname !== "api.github.com") web = url.origin;
    } catch {
      // the review module reports its own config errors
    }
  }
  return `${web}/${repo}`;
}

/** What Lair asks a digest run for */
export function digestQuestion(date: string): string {
  return [
    `Write today's digest (${date}) for the owner, from Lair's records of the last 24 hours, with the days before for the trend:`,
    "what moved; what is stuck, and since when; the holds and decisions waiting for the owner; failures that repeat;",
    "the self-checks failing; and the trend. Say \"nothing\" for a part with nothing in it.",
  ].join(" ");
}

/** A refusal, with the HTTP status the routes answer with. `retry`: a digest tries again soon. */
export class ChatError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly retry = false,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

/** What the chat needs from the agents module (AgentsManager has it). */
export interface ChatAgents {
  requestRun(
    project: string,
    input: { agent: string; task: string; prompt: string; variables: Record<string, string>; ownPrompt?: boolean },
  ): Promise<AgentRunView>;
  getStore(): {
    getRun(id: string): AgentRun | null;
    chainRuns(chainId: string): AgentRun[];
    activeRunForAgent(project: string, agent: string): AgentRun | null;
  } | null;
  /** Stop a task's run: its claim is released, and the run stops on the agents module's next check */
  releaseClaim(project: string, task: string, why: string): Promise<unknown>;
}

export interface SupervisorChatOptions {
  supervisor: Supervisor;
  store: SupervisorStore;
  tokens: OpsTokens;
  agents?: ChatAgents;
  config(project: string): ProjectConfig;
  /** The Decision Inbox's list, for the context's open decisions */
  decisions?(options: ListOptions): Decision[];
  /** The Decision Inbox, for the digest's notice */
  inbox?: DecisionProducer;
  /** Lair's notifications are on (data/server.yaml): only then is a digest's notice raised */
  notificationsOn?(): boolean;
  /** This server's address, for LAIR_URL */
  serverUrl?: string;
  clock(): number;
  /** How runs call Lair's CLI (default: the built one, else `lair`) */
  cli?: string;
  /** Lair's own prompt template (default: prompts/supervisor.md) */
  defaultPromptPath?: string;
  log?: Pick<Console, "warn">;
}

export class SupervisorChat {
  private queue: Promise<unknown> = Promise.resolve();
  private checking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private soonTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** project -> the last time a digest was tried and couldn't start yet */
  private digestTried = new Map<string, { date: string; at: number }>();
  /** Answered turns whose runs were already stopped past their deadline */
  private stoppedAfterAnswer = new Set<string>();
  /** project -> the supervisor agent as the status last read it */
  private agentCache = new Map<string, { generation: number; at: number; value: { agent: string } | { problem: string } }>();
  private readonly cli: string;
  private readonly log: Pick<Console, "warn">;

  constructor(private readonly o: SupervisorChatOptions) {
    this.cli = o.cli ?? defaultCli();
    this.log = o.log ?? console;
  }

  /** One ask, digest start or answer at a time: two of them never start two runs or take two answers. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  // ============ SETTINGS ============

  private settingsFor(project: string): SupervisorSettings {
    const settings = this.o.supervisor.settingsOf(project);
    const problems = this.o.supervisor.problemsOf(project);
    // With errors in the block, only its checks are in effect: questions and the digest wait for the fix
    if (problems.length > 0) throw new ChatError(409, `The supervisor block of ${project} has errors: ${problems.join("; ")}`);
    if (!settings) throw new ChatError(409, `No project ${project}`);
    return settings;
  }

  /**
   * The supervisor agent for the chat's status, read again at most every
   * AGENT_CACHE_MS, and at once after the project's config was reloaded
   * (its agents, dragons, ai or planner block changed). A run's start
   * always reads it afresh.
   */
  private cachedAgent(project: string, settings: SupervisorSettings): { agent: string } | { problem: string } {
    const now = this.o.clock();
    const generation = this.o.supervisor.generationOf(project);
    const cached = this.agentCache.get(project);
    if (cached && cached.generation === generation && now - cached.at < AGENT_CACHE_MS) return cached.value;
    const value = supervisorAgent(this.o.config(project), settings);
    this.agentCache.set(project, { generation, at: now, value });
    return value;
  }

  private configOf(project: string): ProjectConfig {
    try {
      return this.o.config(project);
    } catch (e) {
      throw new ChatError(409, `The config of ${project} can't be read: ${message(e)}`);
    }
  }

  private policy(project: string): LinkPolicy {
    try {
      return { repoUrl: repoWebUrl(this.o.config(project)) };
    } catch {
      return { repoUrl: null };
    }
  }

  private template(config: ProjectConfig, settings: SupervisorSettings): string {
    if (settings.promptFile) {
      try {
        return readPromptFile(getPromptsDir(config), settings.promptFile).text;
      } catch (e) {
        throw new ChatError(409, `supervisor.prompt_file ${settings.promptFile}: ${message(e)}`);
      }
    }
    try {
      return readFileSync(this.o.defaultPromptPath ?? DEFAULT_PROMPT_PATH, "utf-8").slice(0, MAX_TEMPLATE_CHARS);
    } catch {
      throw new ChatError(500, "Lair's own supervisor prompt (prompts/supervisor.md) can't be read: set supervisor.prompt_file");
    }
  }

  /** The bounds every supervisor run of the project starts within. */
  private checkLimits(project: string, chat: ChatSettings, now: number): void {
    const runs = this.o.store.runsSince(project, now - DAY);
    if (runs >= chat.max_runs_per_day) {
      throw new ChatError(
        429,
        `${runs} supervisor runs started in the last 24 hours, the most supervisor.chat.max_runs_per_day allows: try again later`,
      );
    }
    const last = this.o.store.lastRunAt(project);
    const wait = last === null ? 0 : last + chat.min_interval_seconds * 1000 - now;
    if (wait > 0) {
      throw new ChatError(
        429,
        `The last supervisor run started less than supervisor.chat.min_interval_seconds (${chat.min_interval_seconds} s) ago: try again at ${iso(now + wait)}`,
        true,
      );
    }
  }

  // ============ STARTING A RUN ============

  /** Start one supervisor run for a new turn; the turn is stored once the run is requested. */
  private async startRun(p: {
    project: string;
    settings: SupervisorSettings;
    kind: ConversationKind;
    question: string;
    conversation: StoredConversation | null;
    turns: StoredTurn[];
    digestDate: string | null;
  }): Promise<{ conversation: StoredConversation; turn: StoredTurn }> {
    const agents = this.o.agents;
    if (!agents) throw new ChatError(503, "The agents module doesn't run in this server");
    const now = this.o.clock();
    const config = this.configOf(p.project);
    const found = supervisorAgent(config, p.settings);
    if ("problem" in found) throw new ChatError(409, found.problem);
    this.checkLimits(p.project, p.settings.chat, now);
    // The agent busy with another run is the one wait that passes by itself (a digest tries again soon); no token yet
    const busy = agents.getStore()?.activeRunForAgent(p.project, found.agent) ?? null;
    if (busy) {
      throw new ChatError(
        409,
        `The supervisor agent ${found.agent} is busy: run ${busy.id.slice(0, 8)} on task ${busy.task} is ${busy.state}`,
        true,
      );
    }
    const template = this.template(config, p.settings);

    const conversationId = p.conversation?.id ?? randomUUID();
    const seq = p.turns.length + 1;
    const task =
      p.kind === "digest" && p.digestDate
        ? `supervisor-digest-${p.digestDate.replace(/-/g, "")}`
        : `supervisor-ask-${conversationId.slice(0, 8)}-${seq}`;
    const timeoutMs = p.settings.chat.answer_timeout_minutes * 60_000;
    const repoUrl = repoWebUrl(config);
    const prompt = buildSupervisorPrompt({
      template,
      project: p.project,
      kind: p.kind,
      conversationId,
      question: p.question,
      digestDate: p.digestDate,
      history: p.turns,
      diagnostics: this.o.supervisor.diagnostics(p.project),
      decisions: this.openDecisions(p.project),
      cli: this.cli,
      timeoutMinutes: p.settings.chat.answer_timeout_minutes,
      repoUrl,
      now,
    });

    // The token exists before the run, so it can be in the run's environment; it reads nothing until bound to it
    const minted = this.o.tokens.mintForPendingRun(p.project, timeoutMs);
    let run: AgentRunView;
    try {
      run = await agents.requestRun(p.project, {
        agent: found.agent,
        task,
        prompt,
        variables: {
          LAIR_OPS_TOKEN: minted.token,
          LAIR_SUPERVISOR_CONVERSATION: conversationId,
          ...(this.o.serverUrl ? { LAIR_URL: this.o.serverUrl } : {}),
        },
        // The supervisor's prompt is the whole task: not the builders' default_instructions before it
        ownPrompt: true,
      });
    } catch (e) {
      this.o.tokens.revoke(minted.info.id);
      const status = typeof (e as { statusCode?: unknown }).statusCode === "number" ? (e as { statusCode: number }).statusCode : 500;
      // Only the agent becoming busy meanwhile passes by itself; a claimed task, a held agent, the budget don't
      const nowBusy = status === 409 && (agents.getStore()?.activeRunForAgent(p.project, found.agent) ?? null) !== null;
      throw new ChatError(status, `The supervisor run could not start: ${message(e)}`, nowBusy);
    }
    this.o.tokens.bindRun(minted.info.id, run.id);

    const conversation: StoredConversation = p.conversation ?? {
      id: conversationId,
      project: p.project,
      kind: p.kind,
      digestDate: p.digestDate,
      createdAt: now,
      updatedAt: now,
    };
    const turn: StoredTurn = {
      id: randomUUID(),
      conversationId,
      seq,
      question: p.question,
      askedAt: now,
      state: "pending",
      runId: run.id,
      agent: found.agent,
      task,
      deadlineAt: now + timeoutMs,
      answer: null,
      evidence: [],
      answeredAt: null,
      reason: null,
    };
    try {
      this.o.store.addTurn(conversation, turn, p.conversation === null);
    } catch (e) {
      // Not kept, so never answered: the run goes too
      this.o.tokens.endRun(run.id);
      await agents.releaseClaim(p.project, task, "the supervisor: its question could not be stored").catch(() => undefined);
      throw e;
    }
    return { conversation, turn };
  }

  private openDecisions(project: string): Decision[] {
    try {
      return this.o.decisions?.({ project, status: "open", limit: 100 }) ?? [];
    } catch {
      return [];
    }
  }

  // ============ ASKING ============

  /** The owner's question: a new conversation, or the next question of one. */
  ask(input: { project: string; question: unknown; conversationId?: unknown }): Promise<ConversationView> {
    return this.exclusive(async () => {
      const question = typeof input.question === "string" ? plainText(input.question, MAX_QUESTION + 1).trim() : "";
      if (question.length === 0) throw new ChatError(400, "question: the question, as text");
      if (question.length > MAX_QUESTION) throw new ChatError(400, `question: at most ${MAX_QUESTION} characters`);
      let existing: StoredConversation | null = null;
      const id = input.conversationId;
      if (id !== undefined && id !== null && id !== "") {
        if (typeof id !== "string" || !UUID.test(id)) throw new ChatError(400, "conversationId: a conversation's id");
        existing = this.o.store.getConversation(id);
        if (!existing || existing.project !== input.project || existing.kind !== "chat") {
          throw new ChatError(404, "No such conversation in this project");
        }
      }
      const settings = this.settingsFor(input.project);
      if (!settings.chat.enabled) {
        throw new ChatError(409, `Questions to the supervisor are off for ${input.project}: set supervisor.chat.enabled`);
      }
      const turns = existing ? this.o.store.turnsOf(existing.id) : [];
      if (turns.some((t) => t.state === "pending")) {
        throw new ChatError(409, "The conversation's last question is still being answered: wait for its answer");
      }
      if (turns.length >= settings.chat.max_conversation_turns) {
        throw new ChatError(
          409,
          `The conversation has ${turns.length} questions, the most supervisor.chat.max_conversation_turns allows: start a new one`,
        );
      }
      const { conversation } = await this.startRun({
        project: input.project,
        settings,
        kind: "chat",
        question,
        conversation: existing,
        turns,
        digestDate: null,
      });
      return this.view(conversation);
    });
  }

  // ============ ANSWERING ============

  /** An answer from `lair supervisor answer`, under its run's token: once, from the run that was asked, while it runs. */
  answer(input: { token: OpsToken; conversation: unknown; answer: unknown; evidence: unknown }): Promise<{ conversation: string; turn: number }> {
    return this.exclusive(async () => {
      const { token } = input;
      if (token.kind !== "run" || token.runId === null) {
        throw new ChatError(403, "Only the supervisor run Lair started for a question can answer it (with its run's token)");
      }
      const id = input.conversation;
      if (typeof id !== "string" || !UUID.test(id)) throw new ChatError(400, "conversation: the conversation's id (LAIR_SUPERVISOR_CONVERSATION)");
      const conversation = this.o.store.getConversation(id);
      if (!conversation || token.projects === "*" || !token.projects.includes(conversation.project)) {
        throw new ChatError(404, "No such conversation");
      }
      const turn = this.o.store.turnsOf(id).find((t) => t.runId === token.runId);
      if (!turn) throw new ChatError(403, "This run was not asked a question in this conversation: its token can't answer here");
      if (turn.state === "answered") throw new ChatError(409, "This question was already answered: an answer counts once");
      if (turn.state === "no_answer") throw new ChatError(409, `This question was closed without an answer (${turn.reason ?? "no reason"})`);
      const now = this.o.clock();
      if (now >= turn.deadlineAt) throw new ChatError(409, "The answer came after the question's deadline (supervisor.chat.answer_timeout_minutes)");

      if (typeof input.answer !== "string" || input.answer.trim().length === 0) throw new ChatError(400, "answer: the answer, as Markdown text");
      if (input.answer.length > 20_000) throw new ChatError(400, "answer: at most 20000 characters");
      const evidence = sanitizeEvidence(input.evidence);
      if (!evidence.ok) throw new ChatError(400, evidence.error);
      const clean = sanitizeAnswer(input.answer, this.policy(conversation.project));
      if (clean.length === 0) throw new ChatError(400, "answer: nothing is left of it once cleaned (no HTML is kept)");
      if (!this.o.store.answerTurn(turn.id, clean, evidence.evidence, now)) {
        throw new ChatError(409, "This question was already answered or closed");
      }
      if (conversation.kind === "digest") await this.noticeDigest(conversation);
      return { conversation: id, turn: turn.seq };
    });
  }

  /** One notice, with notifications on: "Today's digest is ready". Yesterday's, if still open, is withdrawn. */
  private async noticeDigest(conversation: StoredConversation): Promise<void> {
    const inbox = this.o.inbox;
    if (!inbox || !conversation.digestDate) return;
    let on = false;
    try {
      on = this.o.notificationsOn?.() ?? false;
    } catch {
      on = false;
    }
    if (!on) return;
    const key = `digest:${conversation.digestDate}`;
    try {
      for (const open of inbox.openOf(conversation.project, NOTICE_MODULE)) {
        if (open.key.startsWith("digest:") && open.key !== key) {
          await inbox.withdraw(open.id, { module: NOTICE_MODULE, reason: "A newer digest is ready." });
        }
      }
      await inbox.raise({
        project: conversation.project,
        kind: "other",
        attention: "notice",
        title: `Today's digest is ready (${conversation.digestDate})`,
        context: `Lair's supervisor wrote the digest of ${conversation.project} for ${conversation.digestDate}. Home shows it, with the evidence it cites.`,
        options: [{ id: "noted", label: "Noted", consequences: "The notice closes; Home keeps showing the digest." }],
        recommended: { optionId: "noted", reasoning: "Nothing is decided here: the digest is for reading." },
        source: { module: NOTICE_MODULE, ref: key },
        key,
      });
    } catch (e) {
      this.log.warn(`[supervisor] the digest's notice could not be raised: ${message(e)}`);
    }
  }

  // ============ FOLLOWING RUNS ============

  /** Close every pending question whose run ended or whose time is up. Concurrent calls share one; it never rejects. */
  check(): Promise<void> {
    if (!this.checking) {
      this.checking = this.exclusive(() => this.checkNow())
        .catch((e) => this.log.warn(`[supervisor] following supervisor runs failed: ${message(e)}`))
        .finally(() => {
          this.checking = null;
        });
    }
    return this.checking;
  }

  private async checkNow(): Promise<void> {
    if (this.stopped) return;
    const now = this.o.clock();
    const runs = this.o.agents?.getStore() ?? null;
    for (const turn of this.o.store.pendingTurns()) {
      if (now >= turn.deadlineAt) {
        const minutes = Math.round((turn.deadlineAt - turn.askedAt) / 60_000);
        await this.close(turn, `no answer within ${minutes} minutes (supervisor.chat.answer_timeout_minutes): Lair stopped its run`);
        continue;
      }
      if (turn.runId === null) {
        await this.close(turn, "its run never started");
        continue;
      }
      const run = runs?.getRun(turn.runId) ?? null;
      if (run && isActive(run.state)) continue;
      const how = run ? `its run ended ${run.state} (${oneLine(run.detail)})` : "its run is gone";
      // A failover or a recovery goes on in a new run, without a token that works: it is stopped
      await this.close(turn, `no answer: ${how}`);
    }
    // An answered question whose run still goes past its deadline: the run is stopped
    for (const turn of this.o.store.answeredPastDeadline(now, now - DAY)) {
      if (this.stoppedAfterAnswer.has(turn.id)) continue;
      this.stoppedAfterAnswer.add(turn.id);
      await this.stopRun(turn, "answered, and still running past its deadline");
    }
  }

  private async close(turn: StoredTurn & { project: string }, reason: string): Promise<void> {
    this.o.store.closeTurn(turn.id, reason, this.o.clock());
    if (turn.runId) this.o.tokens.endRun(turn.runId);
    await this.stopRun(turn, reason);
  }

  /** Stop what still runs of the turn's chain: its task's claim is released. */
  private async stopRun(turn: StoredTurn & { project: string }, why: string): Promise<void> {
    const agents = this.o.agents;
    const store = agents?.getStore();
    if (!agents || !store || !turn.runId || !turn.task) return;
    const run = store.getRun(turn.runId);
    if (!run || !store.chainRuns(run.chainId).some((r) => isActive(r.state))) return;
    try {
      await agents.releaseClaim(turn.project, turn.task, `the supervisor: ${why}`);
    } catch (e) {
      this.log.warn(`[supervisor] the run of ${turn.task} could not be stopped: ${message(e)}`);
    }
  }

  /** After a restart: a pending question's token is gone with the old process, so it is closed and its run stopped. */
  recover(): Promise<void> {
    return this.exclusive(async () => {
      for (const turn of this.o.store.pendingTurns()) {
        await this.close(turn, "no answer: Lair restarted before it came, and the run's token ended with the restart");
      }
    });
  }

  // ============ THE DIGEST ============

  /** Start today's digest of each project that has one due. Never rejects. */
  async digestTick(): Promise<void> {
    if (this.stopped) return;
    const now = this.o.clock();
    for (const project of this.o.supervisor.projects()) {
      const settings = this.o.supervisor.settingsOf(project);
      if (!settings?.digest.enabled) continue;
      const date = localDate(now);
      if (now < localTimeOn(now, settings.digest.time)) continue;
      if (this.o.store.digestFor(project, date)) continue;
      const tried = this.digestTried.get(project);
      if (tried && tried.date === date && now - tried.at < DIGEST_RETRY_MS) continue;
      await this.exclusive(async () => {
        if (this.o.store.digestFor(project, date)) return;
        try {
          await this.startRun({
            project,
            settings,
            kind: "digest",
            question: digestQuestion(date),
            conversation: null,
            turns: [],
            digestDate: date,
          });
          this.digestTried.delete(project);
        } catch (e) {
          if (e instanceof ChatError && e.retry) {
            this.digestTried.set(project, { date, at: now });
            return;
          }
          // Anything else (the day's cap, the budget, the config): today's digest is skipped, with why, and not tried again
          this.skipDigest(project, date, now, e);
        }
      }).catch((e) => this.log.warn(`[supervisor] ${project}: today's digest failed: ${message(e)}`));
    }
  }

  private skipDigest(project: string, date: string, now: number, error: unknown): void {
    const conversation: StoredConversation = { id: randomUUID(), project, kind: "digest", digestDate: date, createdAt: now, updatedAt: now };
    const turn: StoredTurn = {
      id: randomUUID(),
      conversationId: conversation.id,
      seq: 1,
      question: digestQuestion(date),
      askedAt: now,
      state: "no_answer",
      runId: null,
      agent: null,
      task: null,
      deadlineAt: now,
      answer: null,
      evidence: [],
      answeredAt: null,
      reason: `not started: ${oneLine(message(error))}`,
    };
    this.o.store.addTurn(conversation, turn, true);
    this.log.warn(`[supervisor] ${project}: today's digest was not started: ${oneLine(message(error))}`);
  }

  // ============ VIEWS ============

  view(conversation: StoredConversation): ConversationView {
    return {
      id: conversation.id,
      project: conversation.project,
      kind: conversation.kind,
      digestDate: conversation.digestDate,
      createdAt: iso(conversation.createdAt),
      updatedAt: iso(this.o.store.getConversation(conversation.id)?.updatedAt ?? conversation.updatedAt),
      turns: this.o.store.turnsOf(conversation.id).map(turnView),
      repoUrl: this.policy(conversation.project).repoUrl,
    };
  }

  conversation(id: string): ConversationView | null {
    if (!UUID.test(id)) return null;
    const found = this.o.store.getConversation(id);
    return found ? this.view(found) : null;
  }

  status(project: string): ChatStatusView {
    const now = this.o.clock();
    const settings = this.o.supervisor.settingsOf(project);
    const problems = this.o.supervisor.problemsOf(project);
    let agent: string | null = null;
    let problem: string | null = problems.length > 0 ? `The supervisor block has errors: ${problems.join("; ")}` : null;
    if (settings && problem === null) {
      try {
        const found = this.cachedAgent(project, settings);
        if ("agent" in found) agent = found.agent;
        else problem = found.problem;
      } catch (e) {
        problem = `The config can't be read: ${message(e)}`;
      }
      if (problem === null && !this.o.agents) problem = "The agents module doesn't run in this server";
    }
    const chat = settings?.chat;
    const last = this.o.store.lastRunAt(project);
    const next = last !== null && chat ? last + chat.min_interval_seconds * 1000 : null;
    return {
      project,
      enabled: settings?.chat.enabled ?? false,
      digest: { enabled: settings?.digest.enabled ?? false, time: settings?.digest.time ?? "08:00" },
      agent,
      problem,
      limits: {
        maxRunsPerDay: chat?.max_runs_per_day ?? 0,
        minIntervalSeconds: chat?.min_interval_seconds ?? 0,
        maxConversationTurns: chat?.max_conversation_turns ?? 0,
        answerTimeoutMinutes: chat?.answer_timeout_minutes ?? 0,
      },
      runsToday: this.o.store.runsSince(project, now - DAY),
      nextRunAt: next !== null && next > now ? iso(next) : null,
      conversations: this.o.store.listConversations(project, "chat", 20),
      repoUrl: this.policy(project).repoUrl,
    };
  }

  digest(project: string): DigestView {
    const settings = this.o.supervisor.settingsOf(project);
    const latest = this.o.store.latestDigest(project);
    return {
      project,
      enabled: settings?.digest.enabled ?? false,
      time: settings?.digest.time ?? "08:00",
      latest: latest ? this.view(latest) : null,
    };
  }

  // ============ SCHEDULE ============

  /** Follow runs and start digests every CHAT_CHECK_MS, until stop(). */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.check().then(() => this.digestTick());
    }, CHAT_CHECK_MS);
    this.timer.unref?.();
  }

  /** A run ended: follow it soon rather than on the next round. */
  soon(): void {
    if (this.stopped || this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.check();
    }, 100);
    this.soonTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.timer = null;
    this.soonTimer = null;
    await this.queue.catch(() => undefined);
  }
}
