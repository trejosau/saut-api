import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { jwtVerify, SignJWT } from "jose";
import Stripe from "stripe";
import { ZodError } from "zod";

import { config } from "./config.js";
import { database } from "./db.js";
import { runtimeMetrics } from "./observability.js";
import type { Actor, AppContext } from "./types.js";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "UNKNOWN_ERROR";

export class HttpError extends Error {
  readonly code: ApiErrorCode | string;

  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
    code?: ApiErrorCode | string
  ) {
    super(message);
    this.name = "HttpError";
    this.code = code ?? codeForStatus(statusCode);
  }
}

export type NormalizedApiError = {
  statusCode: number;
  code: ApiErrorCode | string;
  message: string;
  details?: unknown;
};

function codeForStatus(status: number): ApiErrorCode {
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 408) return "TIMEOUT";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status === 422) return "VALIDATION_ERROR";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "SERVICE_UNAVAILABLE";
  if (status >= 500) return "INTERNAL_ERROR";
  return "UNKNOWN_ERROR";
}

/** Converts thrown values at the HTTP boundary without changing route contracts. */
export function normalizeApiError(exception: unknown): NormalizedApiError {
  if (exception instanceof ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of exception.issues) {
      const field = issue.path.length > 0 ? issue.path.join(".") : "_global";
      (fields[field] ??= []).push(issue.message);
    }
    return {
      statusCode: 422,
      code: "VALIDATION_ERROR",
      message: "Revisa los campos enviados.",
      details: { fields },
    };
  }
  if (exception instanceof HttpError) {
    return {
      statusCode: exception.statusCode,
      code: exception.code,
      message: exception.message,
      ...(exception.details === undefined ? {} : { details: exception.details }),
    };
  }

  const candidate = exception as { statusCode?: unknown; status?: unknown; message?: unknown; validation?: unknown } | null;
  const statusCode = Number(candidate?.statusCode ?? candidate?.status ?? 500);
  const safeStatus = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
  const details = candidate?.validation;
  return {
    statusCode: safeStatus,
    code: codeForStatus(safeStatus),
    message: safeStatus >= 500 ? "No se pudo completar la operación." : String(candidate?.message ?? "Solicitud inválida"),
    ...(details === undefined ? {} : { details }),
  };
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmac(value: string, secret = config.AUTH_CODE_SECRET): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

const sensitiveKey = /(password|token|secret|authorization|cookie|api[_-]?key|totp|recovery|session[_-]?id|client[_-]?secret|credential)/i;

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redactSensitive(item),
    ]));
  }
  return value;
}

/** Performs an external request with a bounded deadline and no implicit redirects. */
export async function fetchExternal(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = config.EXTERNAL_REQUEST_TIMEOUT_MS,
  provider = "external",
): Promise<Response> {
  runtimeMetrics.recordProviderRequest(provider);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const callerSignal = init.signal;
  const abortCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", abortCaller, { once: true });
  }
  try {
    const response = await fetch(input, {
      ...init,
      redirect: init.redirect ?? "error",
      signal: controller.signal,
    });
    if (!response.ok) runtimeMetrics.recordProviderError(provider, undefined, response.status);
    return response;
  } catch (error) {
    runtimeMetrics.recordProviderError(provider, timedOut ? new DOMException("The operation timed out", "AbortError") : error);
    throw new HttpError(503, "Proveedor externo no disponible", undefined, "SERVICE_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortCaller);
  }
}

/** Records provider SDK calls while preserving their existing error contract. */
export async function withProviderMetrics<T>(provider: string, operation: () => Promise<T>): Promise<T> {
  runtimeMetrics.recordProviderRequest(provider);
  try {
    return await operation();
  } catch (error) {
    runtimeMetrics.recordProviderError(provider, error);
    throw error;
  }
}

export function recordProviderFailure(provider: string, error?: unknown): void {
  runtimeMetrics.recordProviderError(provider, error);
}

const tokenSecret = new TextEncoder().encode(config.AUTH_TOKEN_SECRET);

export async function signAccessToken(actor: Omit<Actor, "roles" | "permissions">): Promise<string> {
  return new SignJWT({ actor_type: actor.actorType, session_id: actor.sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(actor.accountId)
    .setIssuedAt()
    .setExpirationTime(`${config.AUTH_ACCESS_TTL_SEC}s`)
    .sign(tokenSecret);
}

export async function accountAccess(accountId: string): Promise<{ roles: string[]; permissions: string[] }> {
  const [roles, permissions] = await Promise.all([
    database.query<{ code: string }>(`
      select r.code from account_roles ar join roles r on r.id = ar.role_id
      where ar.account_id = $1 and (ar.expires_at is null or ar.expires_at > now()) order by r.code
    `, [accountId]),
    database.query<{ key: string }>(`
      with role_grants as (
        select distinct p.id, p.screen || ':' || p.action as key
        from account_roles ar join role_permissions rp on rp.role_id = ar.role_id
        join permissions p on p.id = rp.permission_id
        where ar.account_id = $1 and (ar.expires_at is null or ar.expires_at > now())
      ), overrides as (
        select p.id, p.screen || ':' || p.action as key, apo.effect
        from account_permission_overrides apo join permissions p on p.id = apo.permission_id
        where apo.account_id = $1
      )
      select key from role_grants where id not in (select id from overrides where effect = 'deny')
      union select key from overrides where effect = 'allow' order by key
    `, [accountId])
  ]);
  return { roles: roles.rows.map((row) => row.code), permissions: permissions.rows.map((row) => row.key) };
}

export async function verifyAccessToken(token: string): Promise<Actor> {
  try {
    const { payload } = await jwtVerify(token, tokenSecret, { algorithms: ["HS256"] });
    if (!payload.sub) throw new Error("missing subject");
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    if (!sessionId) throw new Error("missing session");
    const account = await database.query<{ actor_type: string; status: string }>(
      "select actor_type, status from accounts where id = $1",
      [payload.sub]
    );
    const row = account.rows[0];
    if (!row || row.status !== "active") throw new HttpError(401, "Cuenta inactiva o inexistente");
    const session = await database.query<{ account_id: string; revoked_at: Date | null; expires_at: Date }>(
      "select account_id, revoked_at, expires_at from sessions where id = $1 and account_id = $2",
      [sessionId, payload.sub]
    );
    const expiresAt = session.rows[0] ? new Date(session.rows[0].expires_at).getTime() : Number.NaN;
    if (!session.rows[0] || session.rows[0].revoked_at !== null || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new HttpError(401, "Sesión revocada o expirada");
    }
    const security = await database.query<{
      mfa_verified_at: Date | null; step_up_verified_at: Date | null; step_up_method: string | null;
      mfa_enabled: boolean; mfa_mode: string; required_roles: string[];
    }>(
      `select s.mfa_verified_at, s.step_up_verified_at, s.step_up_method,
        coalesce(am.enabled, false) as mfa_enabled, coalesce(mp.mode, 'optional') as mfa_mode,
        coalesce(mp.required_roles, '{}') as required_roles
       from sessions s
       left join account_mfa am on am.account_id = s.account_id
       left join mfa_policy mp on mp.id = 1
       where s.id = $1 and s.account_id = $2`,
      [sessionId, payload.sub]
    );
    const access = await accountAccess(payload.sub);
    const sessionState = security.rows[0];
    const requiredRoles = Array.isArray(sessionState?.required_roles) ? sessionState.required_roles : [];
    const mfaRequired = sessionState?.mfa_mode === "required_all"
      || (sessionState?.mfa_mode === "required_roles" && access.roles.some((role) => requiredRoles.includes(role)));
    return {
      accountId: payload.sub,
      actorType: row.actor_type,
      sessionId,
      ...access,
      mfaRequired,
      mfaEnabled: Boolean(sessionState?.mfa_enabled),
      mfaVerifiedAt: sessionState?.mfa_verified_at ?? null,
      stepUpVerifiedAt: sessionState?.step_up_verified_at ?? null,
      stepUpMethod: sessionState?.step_up_method ?? null
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "Token inválido o expirado");
  }
}

export function bearerToken(request: FastifyRequest): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice(7).trim() || null;
}

export async function authenticate(request: FastifyRequest, options: { allowMfaPending?: boolean } = {}): Promise<Actor> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Se requiere autenticación");
  const actor = await verifyAccessToken(token);
  if (actor.mfaRequired && !actor.mfaVerifiedAt && !options.allowMfaPending) {
    throw new HttpError(403, "Se requiere autenticación multifactor", undefined, "MFA_REQUIRED");
  }
  request.actor = actor;
  return actor;
}

export function requirePermission(actor: Actor, permission?: string): void {
  if (permission && actor.permissions.includes(permission)) return;
  throw new HttpError(403, "Permiso insuficiente");
}

export async function audit(request: FastifyRequest, action: string, resourceType: string, resourceId?: string, payload?: unknown): Promise<void> {
  await database.query(`
    insert into audit_log (id, account_id, actor_type, action, resource_type, resource_id, payload, ip, user_agent)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, [randomUUID(), request.actor?.accountId ?? null, request.actor?.actorType ?? "system", action, resourceType,
    resourceId ?? null, payload === undefined ? null : JSON.stringify(redactSensitive(payload)), request.ip, request.headers["user-agent"] ?? null]);
}

export function pagination(query: Record<string, unknown>): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), config.PAGINATION_MAX);
  const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
  return { limit, offset };
}

export function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

const closingContexts = new WeakMap<AppContext, Promise<void>>();

/** Closes resources owned by an application context exactly once. */
export function closeAppContext(context: AppContext): Promise<void> {
  const existing = closingContexts.get(context);
  if (existing) return existing;

  const closing = (async () => {
    let closeError: unknown;
    for (const socket of context.sockets) {
      try {
        socket.close();
      } catch (error) {
        closeError ??= error;
      }
    }
    context.sockets.clear();
    try {
      context.redis.disconnect();
    } catch (error) {
      closeError ??= error;
    }
    try {
      context.s3.destroy();
    } catch (error) {
      closeError ??= error;
    }
    try {
      await context.database.close();
    } catch (error) {
      closeError ??= error;
    }
    if (closeError) throw closeError;
  })();
  closingContexts.set(context, closing);
  return closing;
}

export async function createContext(): Promise<AppContext> {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  redis.on("error", (error: Error) => console.error("Redis error", error.message));
  let s3: S3Client | undefined;
  try {
    await redis.connect().catch((error: Error) => {
      if (!config.RATE_LIMIT_FAIL_OPEN) throw error;
    });
    s3 = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY }
    });
    try {
      await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
    }
    const stripe = new Stripe(config.STRIPE_SECRET_KEY);
    return { database, redis, s3: s3!, stripe, sockets: new Set() };
  } catch (error) {
    try {
      redis.disconnect();
    } catch {
      // Preserve the original startup error.
    }
    try {
      s3?.destroy();
    } catch {
      // Preserve the original startup error.
    }
    throw error;
  }
}

async function globalRateLimit(request: FastifyRequest): Promise<void> {
  const key = `rate:global:${request.ip}:${Math.floor(Date.now() / (config.RATE_LIMIT_GLOBAL_WINDOW_SEC * 1000))}`;
  try {
    const count = await request.server.context.redis.incr(key);
    if (count === 1) await request.server.context.redis.expire(key, config.RATE_LIMIT_GLOBAL_WINDOW_SEC + 1);
    if (count > config.RATE_LIMIT_GLOBAL_MAX) throw new HttpError(429, "Demasiadas solicitudes");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (!config.RATE_LIMIT_FAIL_OPEN) throw new HttpError(503, "Rate limit no disponible");
  }
}

export function permissionForPath(path: string, method: string): string | undefined {
  const normalizedPath = path.split("?", 1)[0] ?? path;
  const action = method === "GET" || method === "HEAD" ? "read" : "write";
  if (normalizedPath === "/admin/auth/audit-log" || normalizedPath.startsWith("/admin/auth/audit-log/")
    || normalizedPath === "/admin/auth/events" || normalizedPath.startsWith("/admin/auth/events/")) return "auth:audit_read";
  if (normalizedPath.startsWith("/admin/auth/")) return "auth:rbac_manage";
  if (normalizedPath.startsWith("/admin/assets/sign-upload")) return "assets:write";
  if (normalizedPath.startsWith("/admin/assets/")) return "assets:read";
  if (normalizedPath.startsWith("/admin/pricing/quote-order")) return "pricing:read";
  if (normalizedPath.startsWith("/admin/pricing/")) return `pricing:${action}`;
  if (normalizedPath.startsWith("/admin/notifications/")) return `notifications:${action}`;
  if (normalizedPath.startsWith("/admin/support/cases/") && normalizedPath.endsWith("/refunds")) return "payments:refund";
  for (const module of ["catalog", "inventory", "orders", "shipping", "support"] as const) {
    if (normalizedPath.includes(`/${module}`) || (module === "orders" && normalizedPath.includes("/work-orders"))) return `${module}:${action}`;
  }
  if (normalizedPath.includes("/analytics")) return "analytics:read";
  return undefined;
}

export async function buildFastifyServer(context: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['set-cookie']",
          "req.body.password",
          "req.body.token",
          "req.body.refresh_token",
          "req.body.code",
          "req.body.secret",
          "res.headers['set-cookie']",
        ],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: config.REQUEST_BODY_LIMIT_BYTES,
    trustProxy: true,
    requestIdHeader: "x-request-id",
  });
  try {
    app.context = context;
    app.addHook("onRequest", async (request) => {
      runtimeMetrics.startRequest(request);
    });
    app.addHook("onResponse", async (request, reply) => {
      runtimeMetrics.finishRequest(request, reply.statusCode);
    });
    app.addHook("onSend", async (request, reply, payload) => {
      reply.header("x-request-id", request.id);
      reply.header("x-content-type-options", "nosniff");
      reply.header("referrer-policy", "no-referrer");
      reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
      reply.header("content-security-policy", "frame-ancestors 'none'");
      if (config.NODE_ENV === "production") reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
      return payload;
    });
    await app.register(cors, {
      origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)),
      credentials: true
    });
    await app.register(websocket);
    app.addContentTypeParser(["application/octet-stream", "application/pdf", "image/png", "image/jpeg", "image/webp"], { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    app.addHook("preParsing", (request, _reply, payload, done) => {
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        done(null, payload);
        return;
      }
      const rawBody = new PassThrough();
      const chunks: Buffer[] = [];
      payload.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      payload.once("end", () => { request.rawBody = Buffer.concat(chunks).toString("utf8"); });
      payload.once("error", (error) => rawBody.destroy(error));
      payload.pipe(rawBody);
      done(null, rawBody);
    });
    app.addHook("onRequest", globalRateLimit);
    app.addHook("preHandler", async (request) => {
      const path = request.url.split("?", 1)[0] ?? request.url;
      if (path.startsWith("/admin/") || path.startsWith("/ops/")) {
        const actor = await authenticate(request);
        requirePermission(actor, permissionForPath(path, request.method));
      }
      if ((path.startsWith("/internal/") || path.startsWith("/notifications/")) && request.headers["x-internal-api-key"] !== config.AUTH_INTERNAL_API_KEY) {
        throw new HttpError(401, "API key interna inválida");
      }
      if (path === "/metrics" && request.headers["x-internal-api-key"] !== config.AUTH_INTERNAL_API_KEY) {
        throw new HttpError(401, "API key interna inválida");
      }
    });
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

export async function readiness(context: AppContext): Promise<{ status: string; service: string; version: string }> {
  try {
    await context.database.ping();
    if (context.redis.status === "ready") await context.redis.ping();
    await context.s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
    return { status: "ready", service: "saut-api", version: "1.0.0" };
  } catch {
    throw new HttpError(503, "Servicio no listo", undefined, "SERVICE_UNAVAILABLE");
  }
}

export { DeleteObjectCommand, GetObjectCommand, PutObjectCommand };
