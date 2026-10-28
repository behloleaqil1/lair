/**
 * Request latency for the request_latency check: a Fastify onResponse hook
 * keeps each request's duration and route pattern (never its URL, whose
 * query can hold anything) in a bounded ring, and p95() reads a window of
 * it. The event stream of the bus is left out: it stays open by design.
 */
import type { FastifyInstance } from "fastify";

const MAX_SAMPLES = 5000;

/** Routes that answer by staying open (Server-Sent Events) */
const STREAMING = new Set(["/api/bus/events"]);

interface Sample {
  at: number;
  ms: number;
  route: string;
}

export interface LatencySummary {
  /** Requests answered in the window */
  count: number;
  p95Ms: number | null;
  maxMs: number | null;
  /** The route of the slowest request in the window (its pattern, e.g. /api/dragons/:id) */
  slowestRoute: string | null;
}

export class RequestLatency {
  private samples: Sample[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  record(ms: number, route: string): void {
    if (!Number.isFinite(ms) || ms < 0 || STREAMING.has(route)) return;
    this.samples.push({ at: this.now(), ms, route: route.slice(0, 120) });
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  /** The requests answered in the last `windowMs`. */
  summary(windowMs: number): LatencySummary {
    const since = this.now() - windowMs;
    const recent = this.samples.filter((s) => s.at >= since);
    if (recent.length === 0) return { count: 0, p95Ms: null, maxMs: null, slowestRoute: null };
    const sorted = recent.map((s) => s.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    let slowest = recent[0];
    for (const s of recent) if (s.ms > slowest.ms) slowest = s;
    return { count: recent.length, p95Ms: Math.round(p95), maxMs: Math.round(slowest.ms), slowestRoute: slowest.route };
  }
}

/**
 * Record every request's duration. Registered on the root instance before
 * any route, so every route has it.
 */
export function registerLatencyHook(fastify: FastifyInstance, latency: RequestLatency): void {
  fastify.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "(no route)";
    latency.record(reply.elapsedTime, route);
  });
}
