import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { jwtVerify, SignJWT } from "jose";
import Stripe from "stripe";

import { config } from "./config.js";
import { pingDatabase, pool } from "./db.js";
import type { Actor, AppContext } from "./types.js";

export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly details?: unknown) {
    super(message);
  }
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
    pool.query<{ code: string }>(`
      select r.code from account_roles ar join roles r on r.id = ar.role_id
      where ar.account_id = $1 and (ar.expires_at is null or ar.expires_at > now()) order by r.code
    `, [accountId]),
    pool.query<{ key: string }>(`
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
    const account = await pool.query<{ actor_type: string; status: string }>(
      "select actor_type, status from accounts where id = $1",
      [payload.sub]
    );
    const row = account.rows[0];
    if (!row || row.status !== "active") throw new HttpError(401, "Cuenta inactiva o inexistente");
    const access = await accountAccess(payload.sub);
    return {
      accountId: payload.sub,
      actorType: String(payload.actor_type ?? row.actor_type),
      sessionId: payload.session_id ? String(payload.session_id) : undefined,
      ...access
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

export async function authenticate(request: FastifyRequest): Promise<Actor> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Se requiere autenticación");
  const actor = await verifyAccessToken(token);
  request.actor = actor;
  return actor;
}

export function requirePermission(actor: Actor, permission?: string): void {
  if (actor.roles.includes("admin")) return;
  if (permission && actor.permissions.includes(permission)) return;
  throw new HttpError(403, "Permiso insuficiente");
}

export async function audit(request: FastifyRequest, action: string, resourceType: string, resourceId?: string, payload?: unknown): Promise<void> {
  await pool.query(`
    insert into audit_log (id, account_id, actor_type, action, resource_type, resource_id, payload, ip, user_agent)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, [randomUUID(), request.actor?.accountId ?? null, request.actor?.actorType ?? "system", action, resourceType,
    resourceId ?? null, payload ? JSON.stringify(payload) : null, request.ip, request.headers["user-agent"] ?? null]);
}

export function pagination(query: Record<string, unknown>): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
  return { limit, offset };
}

export function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export async function createContext(): Promise<AppContext> {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  redis.on("error", (error: Error) => console.error("Redis error", error.message));
  await redis.connect().catch((error: Error) => {
    if (!config.RATE_LIMIT_FAIL_OPEN) throw error;
  });
  const s3 = new S3Client({
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
  return { pool, redis, s3, stripe, sockets: new Set() };
}

async function globalRateLimit(request: FastifyRequest): Promise<void> {
  const key = `rate:global:${request.ip}:${Math.floor(Date.now() / (config.RATE_LIMIT_GLOBAL_WINDOW_SEC * 1000))}`;
  try {
    const count = await (request.server as any).context.redis.incr(key);
    if (count === 1) await (request.server as any).context.redis.expire(key, config.RATE_LIMIT_GLOBAL_WINDOW_SEC + 1);
    if (count > config.RATE_LIMIT_GLOBAL_MAX) throw new HttpError(429, "Demasiadas solicitudes");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (!config.RATE_LIMIT_FAIL_OPEN) throw new HttpError(503, "Rate limit no disponible");
  }
}

function permissionForPath(path: string, method: string): string | undefined {
  const action = method === "GET" ? "read" : "write";
  if (path.includes("/auth/")) return method === "GET" ? "auth:audit_read" : "auth:rbac_manage";
  for (const module of ["catalog", "inventory", "orders", "shipping", "support"] as const) {
    if (path.includes(`/${module}`) || (module === "orders" && path.includes("/work-orders"))) return `${module}:${action}`;
  }
  if (path.includes("/analytics")) return "analytics:read";
  if (path.includes("/notifications")) return "support:read";
  return undefined;
}

export async function buildFastifyServer(context: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 100 * 1024 * 1024, trustProxy: true, requestIdHeader: "x-request-id" });
  (app as any).context = context;
  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)),
    credentials: true
  });
  await app.register(websocket);
  app.addContentTypeParser(["application/octet-stream", "application/pdf", "image/png", "image/jpeg", "image/webp"], { parseAs: "buffer" }, (_request, body, done) => done(null, body));
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
  });
  return app;
}

export async function readiness(context: AppContext): Promise<{ status: string; service: string; version: string }> {
  await pingDatabase();
  if (context.redis.status === "ready") await context.redis.ping();
  await context.s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
  return { status: "ready", service: "saut-api", version: "1.0.0" };
}

export { DeleteObjectCommand, GetObjectCommand, PutObjectCommand };
