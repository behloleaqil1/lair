/**
 * Where notifications go: the desktop (macOS osascript, Linux notify-send)
 * and an ntfy topic (a phone push). Every command is an argv array with a
 * timeout, never a shell; on macOS the text reaches the AppleScript only as
 * run-handler arguments, so the script source is a constant and no text is
 * ever part of it. A sender never throws: it answers with what happened.
 */
import { accessSync, constants, statSync } from "fs";
import { delimiter, isAbsolute, join } from "path";
import type { ChannelResult } from "../../shared/notification-types.js";
import type { CommandRunner } from "../watchdog/probes.js";
import { readNtfyToken, type NotificationSettings } from "./config.js";
import type { ServerConfigFileOptions } from "../restart/server-config.js";

export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 300;
const COMMAND_TIMEOUT_MS = 10_000;
const NTFY_TIMEOUT_MS = 10_000;

export interface NotificationMessage {
  title: string;
  body: string;
  /** The dashboard page it opens (ntfy's Click), or null */
  link: string | null;
}

/** The AppleScript osascript runs: constant; the title and body arrive as `argv`. */
export const OSASCRIPT_SOURCE = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "end run",
] as const;

/** One line of printable text, at most `max` characters: control characters become spaces. */
export function plainText(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0x2028 || code === 0x2029 ? " " : ch;
  }
  const flat = out.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 3).join("")}...` : flat;
}

/** A command argument that can't read as an option. */
function argument(text: string): string {
  return text.startsWith("-") ? ` ${text}` : text;
}

export interface Sender {
  readonly channel: ChannelResult["channel"];
  send(message: NotificationMessage): Promise<ChannelResult>;
}

export interface DesktopOptions {
  runner: CommandRunner;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/** notify-send on PATH, or null. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      continue;
    }
  }
  return null;
}

/** The desktop command for a message on this platform, or why there is none. */
export function desktopCommand(
  message: NotificationMessage,
  options: Omit<DesktopOptions, "runner">,
): { ok: true; argv: string[] } | { ok: false; detail: string } {
  const title = argument(plainText(message.title, MAX_TITLE_CHARS));
  const body = argument(plainText(message.body, MAX_BODY_CHARS));
  if (options.platform === "darwin") {
    return { ok: true, argv: ["osascript", ...OSASCRIPT_SOURCE.flatMap((line) => ["-e", line]), title, body] };
  }
  if (options.platform === "linux") {
    const notifySend = findOnPath("notify-send", options.env);
    if (!notifySend) return { ok: false, detail: "notify-send is not installed (it comes with libnotify)" };
    return { ok: true, argv: [notifySend, "--app-name=Lair", "--", title, body] };
  }
  return { ok: false, detail: `desktop notifications are not supported on ${options.platform}` };
}

/** Whether desktop notifications can be shown here, and how. */
export function desktopAvailability(options: Omit<DesktopOptions, "runner">): { ok: boolean; detail: string } {
  const probe = desktopCommand({ title: "Lair", body: "Lair", link: null }, options);
  if (!probe.ok) return { ok: false, detail: probe.detail };
  return { ok: true, detail: options.platform === "darwin" ? "macOS notifications (osascript)" : `notify-send (${probe.argv[0]})` };
}

function firstLine(text: string): string {
  return plainText(text.split("\n").find((l) => l.trim().length > 0) ?? "", 200);
}

export class DesktopSender implements Sender {
  readonly channel = "desktop" as const;
  constructor(private options: DesktopOptions) {}

  async send(message: NotificationMessage): Promise<ChannelResult> {
    const command = desktopCommand(message, this.options);
    if (!command.ok) return { channel: this.channel, ok: false, detail: command.detail };
    try {
      const out = await this.options.runner.run(command.argv, { timeoutMs: COMMAND_TIMEOUT_MS });
      if (out.code === 0) return { channel: this.channel, ok: true, detail: "shown" };
      const why = firstLine(out.stderr) || firstLine(out.stdout);
      const name = command.argv[0] === "osascript" ? "osascript" : "notify-send";
      return {
        channel: this.channel,
        ok: false,
        detail: out.code === -1 ? `${name} did not finish or could not start${why ? `: ${why}` : ""}` : `${name} exited ${out.code}${why ? `: ${why}` : ""}`,
      };
    } catch (e) {
      return { channel: this.channel, ok: false, detail: `the desktop notification failed: ${plainText(e instanceof Error ? e.message : String(e), 200)}` };
    }
  }
}

/** A header value: ASCII as it is; anything else as an RFC 2047 encoded word, which ntfy decodes. */
export function headerText(text: string): string {
  if (/^[ -~]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf-8").toString("base64")}?=`;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status">>;

export interface NtfyOptions {
  url: string;
  tokenFile: string | null;
  fetch: FetchLike;
  fileOptions?: ServerConfigFileOptions;
}

export class NtfySender implements Sender {
  readonly channel = "ntfy" as const;
  constructor(private options: NtfyOptions) {}

  async send(message: NotificationMessage): Promise<ChannelResult> {
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
      Title: headerText(plainText(message.title, MAX_TITLE_CHARS)),
    };
    if (message.link) headers.Click = message.link;
    if (this.options.tokenFile) {
      const token = readNtfyToken(this.options.tokenFile, this.options.fileOptions);
      if (!token.ok) return { channel: this.channel, ok: false, detail: token.error };
      headers.Authorization = `Bearer ${token.token}`;
    }
    const host = (() => {
      try {
        return new URL(this.options.url).host;
      } catch {
        return "ntfy";
      }
    })();
    try {
      const response = await this.options.fetch(this.options.url, {
        method: "POST",
        headers,
        body: plainText(message.body, MAX_BODY_CHARS),
        redirect: "error",
        signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
      });
      if (response.ok) return { channel: this.channel, ok: true, detail: `sent to ${host}` };
      return { channel: this.channel, ok: false, detail: `${host} answered HTTP ${response.status}` };
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      const why = name === "TimeoutError" || name === "AbortError" ? "no answer within 10 s" : plainText(e instanceof Error ? e.message : String(e), 200);
      return { channel: this.channel, ok: false, detail: `could not reach ${host}: ${why}` };
    }
  }
}

export interface SenderEnvironment {
  runner: CommandRunner;
  fetch: FetchLike;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fileOptions?: ServerConfigFileOptions;
}

/** The senders the settings turn on, in order: desktop, then ntfy. */
export function sendersFor(settings: NotificationSettings, environment: SenderEnvironment): Sender[] {
  const senders: Sender[] = [];
  if (settings.desktop) {
    senders.push(new DesktopSender({ runner: environment.runner, platform: environment.platform, env: environment.env }));
  }
  if (settings.ntfy) {
    senders.push(
      new NtfySender({
        url: settings.ntfy.url,
        tokenFile: settings.ntfy.tokenFile,
        fetch: environment.fetch,
        fileOptions: environment.fileOptions,
      }),
    );
  }
  return senders;
}
