import type { FastifyRequest } from "fastify";

import type { DatabasePoolMetrics } from "./database/prisma-data-source.js";

const MAX_LATENCY_SAMPLES = 1_024;

type ProviderMetric = {
  requestsTotal: number;
  errorsTotal: number;
  timeoutsTotal: number;
  lastErrorAt: string | null;
  lastStatusCode: number | null;
};

export type RuntimeMetricsSnapshot = {
  process: {
    uptimeSeconds: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  http: {
    requestsTotal: number;
    errorsTotal: number;
    clientErrorsTotal: number;
    serverErrorsTotal: number;
    errorRate: number;
    inFlight: number;
    latencyMs: {
      count: number;
      sum: number;
      average: number;
      p50: number;
      p95: number;
      max: number;
    };
  };
  dbPool: DatabasePoolMetrics;
  providers: Record<string, {
    requestsTotal: number;
    errorsTotal: number;
    timeoutsTotal: number;
    errorRate: number;
    lastErrorAt: string | null;
    lastStatusCode: number | null;
  }>;
};

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  const name = String(candidate.name ?? "").toLowerCase();
  const code = String(candidate.code ?? "").toUpperCase();
  const message = String(candidate.message ?? "").toLowerCase();
  return name === "aborterror" || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || message.includes("timeout");
}

function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
}

export class RuntimeMetrics {
  private readonly startedAt = process.hrtime.bigint();
  private readonly requestStartedAt = new WeakMap<FastifyRequest, bigint>();
  private readonly latencySamples: number[] = [];
  private httpRequestsTotal = 0;
  private httpErrorsTotal = 0;
  private httpClientErrorsTotal = 0;
  private httpServerErrorsTotal = 0;
  private httpInFlight = 0;
  private httpLatencySum = 0;
  private httpLatencyMax = 0;
  private readonly providers = new Map<string, ProviderMetric>();

  startRequest(request: FastifyRequest): void {
    this.requestStartedAt.set(request, process.hrtime.bigint());
    this.httpInFlight += 1;
  }

  finishRequest(request: FastifyRequest, statusCode: number): void {
    const startedAt = this.requestStartedAt.get(request);
    if (startedAt === undefined) return;

    this.requestStartedAt.delete(request);
    this.httpInFlight = Math.max(0, this.httpInFlight - 1);
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    this.httpRequestsTotal += 1;
    this.httpLatencySum += latencyMs;
    this.httpLatencyMax = Math.max(this.httpLatencyMax, latencyMs);
    if (this.latencySamples.length === MAX_LATENCY_SAMPLES) this.latencySamples.shift();
    this.latencySamples.push(latencyMs);

    if (statusCode >= 400) this.httpErrorsTotal += 1;
    if (statusCode >= 400 && statusCode < 500) this.httpClientErrorsTotal += 1;
    if (statusCode >= 500) this.httpServerErrorsTotal += 1;
  }

  recordProviderRequest(provider: string): void {
    const metric = this.provider(provider);
    metric.requestsTotal += 1;
  }

  recordProviderError(provider: string, error?: unknown, statusCode?: number): void {
    const metric = this.provider(provider);
    metric.errorsTotal += 1;
    metric.lastErrorAt = new Date().toISOString();
    metric.lastStatusCode = statusCode ?? null;
    if (isTimeout(error)) metric.timeoutsTotal += 1;
  }

  snapshot(dbPool: DatabasePoolMetrics): RuntimeMetricsSnapshot {
    const memory = process.memoryUsage();
    const uptimeSeconds = Number(process.hrtime.bigint() - this.startedAt) / 1_000_000_000;
    const providers: RuntimeMetricsSnapshot["providers"] = {};
    for (const [name, metric] of this.providers) {
      providers[name] = {
        requestsTotal: metric.requestsTotal,
        errorsTotal: metric.errorsTotal,
        timeoutsTotal: metric.timeoutsTotal,
        errorRate: metric.requestsTotal === 0 ? 0 : metric.errorsTotal / metric.requestsTotal,
        lastErrorAt: metric.lastErrorAt,
        lastStatusCode: metric.lastStatusCode,
      };
    }

    return {
      process: {
        uptimeSeconds: Number(uptimeSeconds.toFixed(3)),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
      http: {
        requestsTotal: this.httpRequestsTotal,
        errorsTotal: this.httpErrorsTotal,
        clientErrorsTotal: this.httpClientErrorsTotal,
        serverErrorsTotal: this.httpServerErrorsTotal,
        errorRate: this.httpRequestsTotal === 0 ? 0 : this.httpErrorsTotal / this.httpRequestsTotal,
        inFlight: this.httpInFlight,
        latencyMs: {
          count: this.httpRequestsTotal,
          sum: Number(this.httpLatencySum.toFixed(3)),
          average: this.httpRequestsTotal === 0 ? 0 : Number((this.httpLatencySum / this.httpRequestsTotal).toFixed(3)),
          p50: percentile(this.latencySamples, 0.5),
          p95: percentile(this.latencySamples, 0.95),
          max: Number(this.httpLatencyMax.toFixed(3)),
        },
      },
      dbPool,
      providers,
    };
  }

  private provider(name: string): ProviderMetric {
    const existing = this.providers.get(name);
    if (existing) return existing;
    const metric: ProviderMetric = {
      requestsTotal: 0,
      errorsTotal: 0,
      timeoutsTotal: 0,
      lastErrorAt: null,
      lastStatusCode: null,
    };
    this.providers.set(name, metric);
    return metric;
  }
}

export const runtimeMetrics = new RuntimeMetrics();
