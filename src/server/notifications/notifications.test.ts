/**
 * Notifications, mounted as src/server/index.ts mounts them
 * (mountNotifications): a real Decision Inbox on a real event bus raises the
 * decisions, real files hold data/server.yaml and the reminder's state, and
 * the owner-only routes run on Fastify. Only the boundary is fake: the
 * command runner (osascript, notify-send), fetch (ntfy) and the clock with
 * its timers.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { EventBus } from "../core/event-bus.js";
import { HumanAuth, OWNER_SESSION_HEADER } from "../human-auth/index.js";
import { DecisionInbox } from "../decisions/service.js";
import { DecisionStore } from "../decisions/store.js";
import { MemorySecretStore } from "../decisions/secrets.js";
import type { RaiseDecisionInput } from "../decisions/types.js";
import { parseServerConfig } from "../restart/server-config.js";
import type { CommandOutput, CommandRunner, RunOptions } from "../watchdog/probes.js";
import type { ChannelResult, NotificationStatusView } from "../../shared/notification-types.js";
import { parseNotificationConfig } from "./config.js";
import { mountNotifications } from "./mount.js";
import { DAY_MS, type Notifier, type Timers } from "./notifier.js";
import { OSASCRIPT_SOURCE, desktopCommand, headerText, plainText } from "./senders.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DASHBOARD = "http://127.0.0.1:4777";
const BROWSER = { origin: "http://localhost:4777", "sec-fetch-site": "same-origin" };
const NTFY = "https://ntfy.example.com/lair-topic";
const ON = `# Lair's own config
server:
  update_cmd: ["git", "pull", "--ff-only"]
notifications:
  desktop: true
  ntfy:
    url: ${NTFY}
`;

// ============ BOUNDARY FAKES ============

/** The clock and its timers: advance() runs what falls due, in order, letting each one's work settle. */
class FakeTime implements Timers {
  private due: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;
  settle: () => Promise<void> = async () => undefined;
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
  set(fn: () => void, ms: number): () => void {
    const entry = { at: this.t + Math.max(0, ms), seq: ++this.seq, fn };
    this.due.push(entry);
    return () => {
      this.due = this.due.filter((e) => e !== entry);
    };
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const next = this.due.filter((e) => e.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) break;
      this.due = this.due.filter((e) => e !== next);
      this.t = next.at;
      next.fn();
      await this.settle();
    }
    this.t = end;
    await this.settle();
  }
}

class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  answer: CommandOutput | Error = { code: 0, stdout: "", stderr: "" };
  async run(argv: string[], _options?: RunOptions): Promise<CommandOutput> {
    this.calls.push([...argv]);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

interface Posted {
  url: string;
  headers: Record<string, string>;
  body: string;
}

class FakeNtfy {
  posts: Posted[] = [];
  answer: { ok: boolean; status: number } | Error = { ok: true, status: 200 };
  fetch = async (url: string, init: RequestInit) => {
    this.posts.push({ url, headers: { ...(init.headers as Record<string, string>) }, body: String(init.body) });
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  };
}

// ============ HARNESS ============

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
const stores: DecisionStore[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lair-notify-"));
  dirs.push(dir);
  return dir;
}

interface SetupOptions {
  dir?: string;
  /** data/server.yaml's text; undefined: no file */
  yaml?: string;
  mode?: number;
  start?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  /** Keep decisions in a file (to survive a "restart") */
  decisionsDb?: boolean;
}

async function setup(o: SetupOptions = {}) {
  const dir = o.dir ?? tempDir();
  const configPath = join(dir, "server.yaml");
  if (o.yaml !== undefined) {
    writeFileSync(configPath, o.yaml);
    chmodSync(configPath, o.mode ?? 0o600);
  }
  const time = new FakeTime(o.start ?? NOW);
  const bus = new EventBus();
  const store = new DecisionStore(o.decisionsDb ? join(dir, "decisions.db") : ":memory:");
  stores.push(store);
  const inbox = new DecisionInbox({ store, secrets: new MemorySecretStore(), events: bus, clock: time });
  const runner = new FakeRunner();
  const ntfy = new FakeNtfy();
  const logs: string[] = [];
  const app = Fastify({ logger: false });
  apps.push(app);
  const tokenPath = join(dir, "owner.token");
  const auth = HumanAuth.open({ tokenPath, dbPath: ":memory:" });
  const notifier: Notifier = await mountNotifications(app, {
    configPath,
    statePath: join(dir, "notifications-state.json"),
    events: bus,
    inbox,
    humanAuth: auth,
    dashboardUrl: DASHBOARD,
    clock: time,
    timers: time,
    runner,
    fetch: ntfy.fetch,
    platform: o.platform ?? "darwin",
    env: o.env ?? { PATH: "" },
    fileOptions: o.uid !== undefined ? { uid: o.uid } : undefined,
    log: (line) => logs.push(line),
  });
  time.settle = async () => {
    await notifier.idle();
    await new Promise((resolve) => setImmediate(resolve));
    await notifier.idle();
  };
  await app.ready();
  const owner = { ...BROWSER, [OWNER_SESSION_HEADER]: auth.createSession(readFileSync(tokenPath, "utf-8").trim())!.session };
  return { dir, configPath, time, bus, inbox, store, runner, ntfy, logs, app, notifier, owner };
}

type Harness = Awaited<ReturnType<typeof setup>>;

function ask(h: Harness, key: string, over: Partial<RaiseDecisionInput> = {}) {
  return h.inbox.raise({
    project: "demo",
    kind: "escalation",
    title: `kiro-7 is paused on ${key}: its last run failed while Lair was restarting`,
    context: "Last output: secret-looking log text that must never be sent",
    options: [
      { id: "start_again", label: "Start it again", consequences: "Fill starts it again." },
      { id: "keep_held", label: "Keep it paused", consequences: "Nothing starts." },
    ],
    recommended: { optionId: "keep_held", reasoning: "r" },
    source: { module: "agents", ref: `fill:${key}` },
    key: `fill:${key}`,
    ...over,
  });
}

/** The desktop notifications shown: [title, body], from osascript's argv. */
function shown(h: Harness): [string, string][] {
  return h.runner.calls.map((argv) => [argv[argv.length - 2], argv[argv.length - 1]]);
}

// ============ TESTS ============

describe("notifications: what is sent, and when", () => {
  it("a new action item notifies within a minute, with its title and link; items raised together go out as one", async () => {
    const h = await setup({ yaml: ON });
    const { decision: a } = await ask(h, "feat-a");
    await h.time.advance(4 * SEC);
    expect(h.runner.calls).toEqual([]);
    await h.time.advance(1 * SEC);
    expect(shown(h)).toEqual([
      ["Lair: kiro-7 is paused on feat-a: its last run failed while Lair was restarting, needs you", `Open ${DASHBOARD}/#/decisions/${a.id}`],
    ]);
    expect(h.ntfy.posts).toEqual([
      {
        url: NTFY,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Title: "Lair: kiro-7 is paused on feat-a: its last run failed while Lair was restarting, needs you",
          Click: `${DASHBOARD}/#/decisions/${a.id}`,
        },
        body: `Open ${DASHBOARD}/#/decisions/${a.id}`,
      },
    ]);
    // Titles only: never a decision's context
    expect(JSON.stringify([h.runner.calls, h.ntfy.posts])).not.toContain("log text");

    // Rate limit: B and C come within the minute after it: one notification when the minute ends
    await h.time.advance(5 * SEC);
    await ask(h, "feat-b");
    await h.time.advance(10 * SEC);
    await ask(h, "feat-c");
    await h.time.advance(44 * SEC); // 64 s after the start: the minute since the first ends at 65 s
    expect(h.runner.calls).toHaveLength(1);
    await h.time.advance(1 * SEC);
    expect(shown(h)[1]).toEqual(["Lair: 2 things need you", `Open ${DASHBOARD}/#/decisions`]);
    expect(h.ntfy.posts[1].headers.Click).toBe(`${DASHBOARD}/#/decisions`);
    expect(h.runner.calls).toHaveLength(2);
  });

  it("at most one notification per minute; an item answered before its turn is not sent", async () => {
    const h = await setup({ yaml: ON });
    await ask(h, "feat-a");
    await h.time.advance(5 * SEC); // sent at +5 s
    const { decision: d } = await ask(h, "feat-d");
    await h.time.advance(30 * SEC);
    await h.inbox.answer(d.id, { optionId: "keep_held" });
    await h.time.advance(5 * MIN);
    expect(h.runner.calls).toHaveLength(1);

    // A burst well after that: one notification for all of it
    for (const key of ["e", "f", "g"]) await ask(h, key);
    await h.time.advance(5 * SEC);
    expect(shown(h).map(([title]) => title)).toEqual([
      expect.stringContaining("feat-a"),
      "Lair: 3 things need you",
    ]);
  });

  it("never notifies for a notice, and sends nothing while notifications are off (the default)", async () => {
    const on = await setup({ yaml: ON });
    await ask(on, "breach", {
      attention: "notice",
      options: [{ id: "stand_down", label: "Leave it to me", consequences: "c" }],
      recommended: { optionId: "stand_down", reasoning: "r" },
    });
    await on.time.advance(10 * MIN);
    expect(on.runner.calls).toEqual([]);
    expect(on.ntfy.posts).toEqual([]);

    for (const yaml of [undefined, "server: {}\n", "notifications:\n  desktop: false\n"]) {
      const off = await setup({ yaml });
      await ask(off, "feat-a");
      await off.time.advance(10 * MIN);
      expect(off.runner.calls).toEqual([]);
      expect(off.ntfy.posts).toEqual([]);
      expect(off.notifier.status().settings.enabled).toBe(false);
    }
  });

  it("reminds once a day while action items stay open longer than reminder_hours, also across a restart", async () => {
    const dir = tempDir();
    const yaml = `${ON}  reminder_hours: 4\n`;
    const h = await setup({ dir, yaml, decisionsDb: true });
    const { decision: a } = await ask(h, "feat-a");
    await h.time.advance(5 * SEC); // the new-item notification
    await h.time.advance(4 * HOUR - 10 * MIN);
    expect(h.runner.calls).toHaveLength(1);
    await h.time.advance(15 * MIN); // the first check after 4 h
    expect(shown(h)[1]).toEqual([
      "Lair: kiro-7 is paused on feat-a: its last run failed while Lair was restarting, still needs you",
      `Open ${DASHBOARD}/#/decisions/${a.id}`,
    ]);
    const state = join(dir, "notifications-state.json");
    expect(statSync(state).mode & 0o777).toBe(0o600);
    const remindedAt = Date.parse(JSON.parse(readFileSync(state, "utf-8")).lastReminderAt);
    expect(h.notifier.status().lastReminderAt).toBe(new Date(remindedAt).toISOString());

    await h.time.advance(20 * HOUR);
    expect(h.runner.calls).toHaveLength(2); // not again the same day

    // Lair restarts: the reminder's time is read back, so nothing goes out before the day is over
    await h.app.close();
    apps.splice(apps.indexOf(h.app), 1);
    h.store.close();
    stores.splice(stores.indexOf(h.store), 1);
    const again = await setup({ dir, yaml, decisionsDb: true, start: h.time.now() });
    await again.time.advance(remindedAt + DAY_MS - again.time.now() - MIN);
    expect(again.runner.calls).toEqual([]);
    await again.time.advance(15 * MIN);
    expect(shown(again)).toEqual([[expect.stringContaining("still needs you"), `Open ${DASHBOARD}/#/decisions/${a.id}`]]);

    // A corrupt state file is no reminder yet
    await again.app.close();
    apps.splice(apps.indexOf(again.app), 1);
    again.store.close();
    stores.splice(stores.indexOf(again.store), 1);
    writeFileSync(state, "{not json");
    const third = await setup({ dir, yaml, decisionsDb: true, start: again.time.now() });
    await third.time.advance(2 * MIN);
    expect(shown(third)).toEqual([[expect.stringContaining("still needs you"), expect.any(String)]]);
  });

  it("no reminder for items younger than reminder_hours, and none with reminder_hours: 0", async () => {
    const young = await setup({ yaml: `${ON}  reminder_hours: 8\n` });
    await ask(young, "feat-a");
    await young.time.advance(6 * HOUR);
    expect(young.runner.calls).toHaveLength(1); // only the new-item one

    const never = await setup({ yaml: `${ON}  reminder_hours: 0\n` });
    await ask(never, "feat-a");
    await never.time.advance(30 * HOUR);
    expect(never.runner.calls).toHaveLength(1);
  });
});

describe("notifications: commands and content", () => {
  it("osascript gets a constant script; the text goes in as arguments only", async () => {
    const h = await setup({ yaml: ON });
    await ask(h, "feat-a", { title: `-x "quoted" $(touch /tmp/owned) end tell & \\ 'single'` });
    await h.time.advance(5 * SEC);
    const [argv] = h.runner.calls;
    expect(argv.slice(0, 7)).toEqual(["osascript", "-e", OSASCRIPT_SOURCE[0], "-e", OSASCRIPT_SOURCE[1], "-e", OSASCRIPT_SOURCE[2]]);
    expect(OSASCRIPT_SOURCE.join("\n")).not.toMatch(/quoted|touch/);
    expect(argv).toHaveLength(9);
    expect(argv[7]).toBe(`Lair: -x "quoted" $(touch /tmp/owned) end tell & \\ 'single', needs you`);
  });

  it("notify-send on Linux when it is on PATH, with '--' before the text; none without it", async () => {
    const bin = join(tempDir(), "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "notify-send"), "#!/bin/sh\n");
    chmodSync(join(bin, "notify-send"), 0o755);
    const h = await setup({ yaml: ON, platform: "linux", env: { PATH: bin } });
    await ask(h, "feat-a");
    await h.time.advance(5 * SEC);
    expect(h.runner.calls[0].slice(0, 3)).toEqual([join(bin, "notify-send"), "--app-name=Lair", "--"]);
    expect(h.runner.calls[0]).toHaveLength(5);

    const none = await setup({ yaml: ON, platform: "linux", env: { PATH: tempDir() } });
    expect(none.notifier.status().desktopAvailable).toEqual({ ok: false, detail: expect.stringContaining("notify-send is not installed") });
    await ask(none, "feat-a");
    await none.time.advance(5 * SEC);
    expect(none.runner.calls).toEqual([]);
    expect(none.ntfy.posts).toHaveLength(1); // the other channel still goes out
  });

  it("text is one printable line, bounded; an argument never reads as an option; non-ASCII titles are encoded for ntfy", () => {
    expect(plainText("a\u0007b\nc\td\u001b[31m e", 100)).toBe("a b c d [31m e");
    const long = plainText("x".repeat(500), 120);
    expect([...long]).toHaveLength(120);
    expect(long.endsWith("...")).toBe(true);
    const command = desktopCommand({ title: "-rf", body: "--help", link: null }, { platform: "darwin", env: {} });
    expect(command.ok && command.argv.slice(-2)).toEqual([" -rf", " --help"]);
    expect(desktopCommand({ title: "t", body: "b", link: null }, { platform: "win32", env: {} }).ok).toBe(false);
    expect(headerText("Lair: plain")).toBe("Lair: plain");
    const encoded = headerText("Lair: café is paused");
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(Buffer.from(encoded.slice(10, -2), "base64").toString("utf-8")).toBe("Lair: café is paused");
  });

  it("a long decision title is cut so the notification's title stays within 120 characters", async () => {
    const h = await setup({ yaml: ON });
    await ask(h, "feat-a", { title: `kiro-7 ${"waits ".repeat(40)}`.trim().slice(0, 200) });
    await h.time.advance(5 * SEC);
    const [title] = shown(h)[0];
    expect([...title].length).toBeLessThanOrEqual(120);
    expect(title.startsWith("Lair: kiro-7 waits")).toBe(true);
    expect(title.endsWith("..., needs you")).toBe(true);
  });
});

describe("notifications: failures", () => {
  it("a failing channel is logged once per problem and never throws or holds up the inbox", async () => {
    const h = await setup({ yaml: ON });
    h.runner.answer = { code: 1, stdout: "", stderr: "execution error: Not authorized to send Apple events\n" };
    h.ntfy.answer = new Error("getaddrinfo ENOTFOUND ntfy.example.com");
    await ask(h, "feat-a");
    await h.time.advance(5 * SEC);
    await ask(h, "feat-b");
    await h.time.advance(2 * MIN);
    expect(h.runner.calls).toHaveLength(2);
    expect(h.ntfy.posts).toHaveLength(2);
    expect(h.logs).toEqual([
      "[notifications] desktop: osascript exited 1: execution error: Not authorized to send Apple events",
      "[notifications] ntfy: could not reach ntfy.example.com: getaddrinfo ENOTFOUND ntfy.example.com",
    ]);
    const last = h.notifier.status().last;
    expect(last?.results.map((r: ChannelResult) => r.ok)).toEqual([false, false]);

    // A runner that throws, and an HTTP error: a new problem each, logged once; the inbox goes on
    h.runner.answer = new Error("spawn osascript ENOENT");
    h.ntfy.answer = { ok: false, status: 500 };
    await expect(ask(h, "feat-c")).resolves.toMatchObject({ created: true });
    await h.time.advance(2 * MIN);
    expect(h.logs.slice(2)).toEqual([
      "[notifications] desktop: the desktop notification failed: spawn osascript ENOENT",
      "[notifications] ntfy: ntfy.example.com answered HTTP 500",
    ]);
    expect(h.inbox.list({ status: "open" })).toHaveLength(3);
  });
});

describe("notifications: config and file checks", () => {
  it("parses the section; a mistake in it is refused (notifications off) and never stops a restart", () => {
    expect(parseNotificationConfig({ notifications: { desktop: true } }, "/data")).toEqual({
      ok: true,
      settings: { desktop: true, ntfy: null, reminderHours: 4 },
    });
    expect(
      parseNotificationConfig({ notifications: { ntfy: { url: NTFY, token_file: "ntfy.token" }, reminder_hours: 0 } }, "/data"),
    ).toEqual({ ok: true, settings: { desktop: false, ntfy: { url: NTFY, tokenFile: "/data/ntfy.token" }, reminderHours: 0 } });
    for (const bad of [
      { desktop: "yes" },
      { sound: true },
      { ntfy: { url: "ftp://ntfy.example.com/t" } },
      { ntfy: { url: "https://user:pass@ntfy.example.com/t" } },
      { ntfy: { url: "https://ntfy.example.com/" } },
      { reminder_hours: 1000 },
    ]) {
      expect(parseNotificationConfig({ notifications: bad }, "/data")).toMatchObject({ ok: false, settings: { desktop: false, ntfy: null } });
    }
    // Restart reads the same file: the section is not its business
    expect(parseServerConfig({ server: {}, notifications: { desktop: "yes" } }).ok).toBe(true);
  });

  it("refuses a symbolic link, a group-writable file and another user's file: nothing is sent, and the view says why", async () => {
    const real = tempDir();
    writeFileSync(join(real, "server.yaml"), ON);
    chmodSync(join(real, "server.yaml"), 0o600);
    const linked = tempDir();
    symlinkSync(join(real, "server.yaml"), join(linked, "server.yaml"));
    const cases: [SetupOptions, string][] = [
      [{ dir: linked }, "refused: it is a symbolic link"],
      [{ yaml: ON, mode: 0o664 }, "refused: its group or other users may write it (mode 664)"],
      [{ yaml: ON, uid: (process.getuid?.() ?? 0) + 1 }, "refused: it is owned by another user"],
    ];
    for (const [options, why] of cases) {
      const h = await setup({ platform: "linux", ...options, env: { PATH: "" } });
      await ask(h, "feat-a");
      await h.time.advance(MIN);
      expect(h.ntfy.posts).toEqual([]);
      expect(h.notifier.status().errors[0]).toContain(why);
      expect(h.logs).toEqual([expect.stringContaining(why)]);
    }
  });

  it("ntfy.token_file is a secret: refused when others may read it, else sent as a Bearer token and never shown", async () => {
    const dir = tempDir();
    const yaml = `notifications:\n  ntfy:\n    url: ${NTFY}\n    token_file: ntfy.token\n`;
    writeFileSync(join(dir, "ntfy.token"), "tk_s3cr3t-token\n");
    chmodSync(join(dir, "ntfy.token"), 0o644);
    const h = await setup({ dir, yaml });
    await ask(h, "feat-a");
    await h.time.advance(5 * SEC);
    expect(h.ntfy.posts).toEqual([]);
    expect(h.notifier.status().last?.results).toEqual([
      { channel: "ntfy", ok: false, detail: expect.stringContaining("ntfy.token_file refused: its group or other users may read it") },
    ]);

    chmodSync(join(dir, "ntfy.token"), 0o600);
    await ask(h, "feat-b");
    await h.time.advance(MIN);
    expect(h.ntfy.posts).toHaveLength(1);
    expect(h.ntfy.posts[0].headers.Authorization).toBe("Bearer tk_s3cr3t-token");
    const view = await h.app.inject({ url: "/api/owner/notifications", headers: h.owner });
    expect(view.json().data.settings).toMatchObject({ ntfyUrl: NTFY, ntfyTokenFile: true });
    expect(view.body).not.toContain("tk_s3cr3t");
    expect(h.logs.join("\n")).not.toContain("tk_s3cr3t");
  });
});

describe("notifications: the owner's routes", () => {
  it("refuses every route without the owner's session (403)", async () => {
    const h = await setup({ yaml: ON });
    for (const headers of [BROWSER, { ...BROWSER, [OWNER_SESSION_HEADER]: "not-a-session" }]) {
      expect((await h.app.inject({ url: "/api/owner/notifications", headers })).statusCode).toBe(403);
      expect(
        (await h.app.inject({ method: "PUT", url: "/api/owner/notifications", headers, payload: { desktop: false, ntfyUrl: null } })).statusCode,
      ).toBe(403);
      expect((await h.app.inject({ method: "POST", url: "/api/owner/notifications/test", headers, payload: {} })).statusCode).toBe(403);
    }
    expect(h.runner.calls).toEqual([]);
    expect(readFileSync(h.configPath, "utf-8")).toBe(ON);
  });

  it("PUT writes only the notifications section: server.update_cmd and comments stay, the file ends up 0600", async () => {
    const h = await setup({ yaml: `${ON.replace("  ntfy:\n    url: " + NTFY + "\n", "")}`, mode: 0o644 });
    const put = await h.app.inject({
      method: "PUT",
      url: "/api/owner/notifications",
      headers: h.owner,
      payload: { desktop: false, ntfyUrl: NTFY, reminderHours: 6 },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json().data as NotificationStatusView).settings).toEqual({
      desktop: false,
      ntfyUrl: NTFY,
      ntfyTokenFile: false,
      reminderHours: 6,
      enabled: true,
    });
    const text = readFileSync(h.configPath, "utf-8");
    expect(text).toContain("# Lair's own config");
    expect(text).toContain('update_cmd: ["git", "pull", "--ff-only"]');
    expect(parseServerConfig(parseYaml(text))).toMatchObject({
      ok: true,
      settings: { updateSteps: [["git", "pull", "--ff-only"]] },
    });
    expect(statSync(h.configPath).mode & 0o777).toBe(0o600);

    // Refused: a bad URL (400), and a file that fails the checks (409); nothing written
    const bad = await h.app.inject({
      method: "PUT",
      url: "/api/owner/notifications",
      headers: h.owner,
      payload: { desktop: true, ntfyUrl: "javascript:alert(1)" },
    });
    expect(bad.statusCode).toBe(400);
    chmodSync(h.configPath, 0o666);
    const unsafe = await h.app.inject({
      method: "PUT",
      url: "/api/owner/notifications",
      headers: h.owner,
      payload: { desktop: true, ntfyUrl: null },
    });
    expect(unsafe.statusCode).toBe(409);
    expect(unsafe.json().error).toContain("its group or other users may write it");
    expect(readFileSync(h.configPath, "utf-8")).toBe(text);
  });

  it("PUT creates a missing data/server.yaml, owner-only, and keeps a token_file set in the file", async () => {
    const h = await setup();
    const put = await h.app.inject({
      method: "PUT",
      url: "/api/owner/notifications",
      headers: h.owner,
      payload: { desktop: true, ntfyUrl: null },
    });
    expect(put.statusCode).toBe(200);
    expect(statSync(h.configPath).mode & 0o777).toBe(0o600);
    expect(h.notifier.status().settings).toMatchObject({ desktop: true, ntfyUrl: null, reminderHours: 4, enabled: true });

    writeFileSync(h.configPath, `notifications:\n  ntfy:\n    url: ${NTFY}\n    token_file: ntfy.token\n`);
    chmodSync(h.configPath, 0o600);
    await h.app.inject({
      method: "PUT",
      url: "/api/owner/notifications",
      headers: h.owner,
      payload: { desktop: false, ntfyUrl: "https://ntfy.example.com/other-topic" },
    });
    expect(readFileSync(h.configPath, "utf-8")).toContain("token_file: ntfy.token");
    expect(h.notifier.status().settings).toMatchObject({ ntfyUrl: "https://ntfy.example.com/other-topic", ntfyTokenFile: true });
  });

  it("POST /test sends a test notification through every channel on, with each result; 409 while off", async () => {
    const h = await setup({ yaml: ON });
    const sent = await h.app.inject({ method: "POST", url: "/api/owner/notifications/test", headers: h.owner, payload: {} });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().data.results).toEqual([
      { channel: "desktop", ok: true, detail: "shown" },
      { channel: "ntfy", ok: true, detail: "sent to ntfy.example.com" },
    ]);
    expect(shown(h)[0][0]).toBe("Lair: test notification");
    expect(h.ntfy.posts[0].headers.Title).toBe("Lair: test notification");
    expect(h.notifier.status().last).toMatchObject({ kind: "test", title: "Lair: test notification" });

    // A test doesn't use up the minute: a new item still notifies at once
    await ask(h, "feat-a");
    await h.time.advance(5 * SEC);
    expect(h.runner.calls).toHaveLength(2);

    const off = await setup({ yaml: "notifications:\n  desktop: false\n" });
    const refused = await off.app.inject({ method: "POST", url: "/api/owner/notifications/test", headers: off.owner, payload: {} });
    expect(refused.statusCode).toBe(409);
    expect(off.runner.calls).toEqual([]);
  });
});
