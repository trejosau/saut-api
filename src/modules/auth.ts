import { randomInt, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { config } from "../config.js";
import {
  accountAccess, asObject, audit, authenticate, bearerToken, hmac, HttpError, normalizeEmail,
  randomToken, secureEqual, sha256, signAccessToken, verifyAccessToken
} from "../platform.js";
import type { AppContext } from "../types.js";

const emailSchema = z.string().trim().email().max(320);

type AuthResult = {
  account_id: string;
  session_id: string;
  access_token: string;
  refresh_token: string;
  actor_type: string;
  expires_in_sec: number;
  session_expires_in_sec: number;
  is_new_account: boolean;
  primary_email: string | null;
  return_to?: string | null;
};

type RefreshResult = Pick<AuthResult,
  "account_id" | "session_id" | "access_token" | "refresh_token" | "actor_type" |
  "expires_in_sec" | "session_expires_in_sec" | "primary_email"
>;

const refreshResultSchema = z.object({
  account_id: z.string().min(1),
  session_id: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  actor_type: z.string().min(1),
  expires_in_sec: z.number().positive(),
  session_expires_in_sec: z.number().positive(),
  primary_email: z.string().nullable(),
});

const REFRESH_CLIENT_HEADER = "x-refresh-client";
const REFRESH_ROTATION_CACHE_TTL_SEC = 10;
const REFRESH_ROTATION_LOCK_TTL_SEC = 5;

function refreshClientId(request: FastifyRequest): string | null {
  const value = request.headers[REFRESH_CLIENT_HEADER];
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
}

async function readRefreshRotationCache(context: AppContext, key: string): Promise<RefreshResult | null> {
  let raw: string | null;
  try {
    raw = await context.redis.get(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return refreshResultSchema.parse(JSON.parse(raw));
  } catch {
    await context.redis.del(key).catch(() => undefined);
    return null;
  }
}

async function readActiveRefreshRotationCache(context: AppContext, key: string): Promise<RefreshResult | null> {
  const cached = await readRefreshRotationCache(context, key);
  if (!cached) return null;
  const session = await context.database.query<{ id: string }>(`
    select s.id
    from sessions s join accounts a on a.id = s.account_id
    where s.id = $1 and s.refresh_token_hash = $2
      and s.revoked_at is null and s.expires_at > now() and a.status = 'active'
  `, [cached.session_id, sha256(cached.refresh_token)]);
  return session.rows[0] ? cached : null;
}

async function waitForRefreshRotationCache(context: AppContext, key: string): Promise<RefreshResult | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const cached = await readActiveRefreshRotationCache(context, key);
    if (cached) return cached;
    if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function issueSession(
  context: AppContext,
  account: { id: string; actor_type: string; primary_email: string | null },
  request: FastifyRequest,
  isNewAccount: boolean,
  returnTo?: string | null
): Promise<AuthResult> {
  const sessionId = randomUUID();
  const refreshToken = randomToken(48);
  await context.database.query(`
    insert into sessions (id, account_id, refresh_token_hash, expires_at, ip, user_agent, last_seen_at)
    values ($1,$2,$3,now() + ($4 || ' seconds')::interval,$5,$6,now())
  `, [sessionId, account.id, sha256(refreshToken), config.AUTH_SESSION_TTL_SEC, request.ip, request.headers["user-agent"] ?? null]);
  const accessToken = await signAccessToken({ accountId: account.id, actorType: account.actor_type, sessionId });
  return {
    account_id: account.id,
    session_id: sessionId,
    access_token: accessToken,
    refresh_token: refreshToken,
    actor_type: account.actor_type,
    expires_in_sec: config.AUTH_ACCESS_TTL_SEC,
    session_expires_in_sec: config.AUTH_SESSION_TTL_SEC,
    is_new_account: isNewAccount,
    primary_email: account.primary_email,
    ...(returnTo !== undefined ? { return_to: returnTo } : {})
  };
}

async function findOrCreateEmailAccount(context: AppContext, email: string): Promise<{ account: { id: string; actor_type: string; primary_email: string | null }; created: boolean }> {
  const found = await context.database.query<{ id: string; actor_type: string; primary_email: string | null; status: string }>(`
    select a.id, a.actor_type, a.primary_email, a.status
    from account_identities i join accounts a on a.id = i.account_id
    where i.provider = 'email' and i.email_normalized = $1 limit 1
  `, [email]);
  if (found.rows[0]) {
    if (found.rows[0].status !== "active") throw new HttpError(403, "Cuenta inactiva");
    await context.database.query("update accounts set last_login_at = now(), updated_at = now() where id = $1", [found.rows[0].id]);
    return { account: found.rows[0], created: false };
  }
  if (!config.AUTH_AUTO_CREATE) throw new HttpError(404, "Cuenta no encontrada");
  const id = randomUUID();
  const actorType = config.adminEmails.has(email) ? "admin" : "customer";
  const client = await context.database.connect();
  try {
    await client.query("begin");
    await client.query(`
      insert into accounts (id, actor_type, status, primary_email, last_login_at) values ($1,$2,'active',$3,now())
    `, [id, actorType, email]);
    await client.query(`
      insert into account_identities (id, account_id, provider, provider_subject, email, email_normalized, email_verified, last_used_at)
      values ($1,$2,'email',$3,$3,$3,true,now())
    `, [randomUUID(), id, email]);
    const role = config.adminEmails.has(email) ? "admin" : config.AUTH_DEFAULT_CUSTOMER_ROLE;
    await client.query(`insert into account_roles (id, account_id, role_id)
      select $1,$2,id from roles where code=$3 on conflict(account_id,role_id) do nothing`, [randomUUID(), id, role]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return { account: { id, actor_type: actorType, primary_email: email }, created: true };
}

async function googleDiscovery(): Promise<{ authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string }> {
  const response = await fetch(config.AUTH_GOOGLE_DISCOVERY_URL);
  if (!response.ok) throw new HttpError(503, "Google temporalmente no disponible");
  return response.json() as Promise<any>;
}

async function startGoogle(context: AppContext, returnTo: string | undefined): Promise<{ authorization_url: string; state: string }> {
  if (!config.AUTH_GOOGLE_CLIENT_ID || !config.AUTH_GOOGLE_CLIENT_SECRET) throw new HttpError(503, "Google login no configurado");
  const state = randomToken(32);
  const safeReturn = returnTo?.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  await context.redis.set(`auth:google:${state}`, JSON.stringify({ return_to: safeReturn }), "EX", 600);
  const discovery = await googleDiscovery();
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("client_id", config.AUTH_GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", config.AUTH_GOOGLE_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  return { authorization_url: url.toString(), state };
}

async function exchangeGoogle(context: AppContext, request: FastifyRequest, body: Record<string, any>): Promise<AuthResult> {
  const code = z.string().min(1).max(4096).parse(body.code);
  const state = z.string().min(1).max(512).parse(body.state);
  const stored = await context.redis.getdel(`auth:google:${state}`);
  if (!stored) throw new HttpError(401, "Estado de Google inválido o expirado");
  const stateData = asObject(JSON.parse(stored));
  const discovery = await googleDiscovery();
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.AUTH_GOOGLE_CLIENT_ID,
      client_secret: config.AUTH_GOOGLE_CLIENT_SECRET,
      redirect_uri: String(body.redirect_uri ?? config.AUTH_GOOGLE_REDIRECT_URI),
      grant_type: "authorization_code"
    })
  });
  if (!tokenResponse.ok) throw new HttpError(401, "No se pudo completar el login con Google");
  const tokens = asObject(await tokenResponse.json());
  const userResponse = await fetch(discovery.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  if (!userResponse.ok) throw new HttpError(401, "No se pudo validar la cuenta de Google");
  const user = asObject(await userResponse.json());
  const subject = z.string().min(1).parse(user.sub);
  const email = emailSchema.parse(user.email).toLowerCase();
  if (user.email_verified === false) throw new HttpError(401, "Google no devolvió un email verificado");

  const existing = await context.database.query<{ id: string; actor_type: string; primary_email: string | null; status: string }>(`
    select a.id, a.actor_type, a.primary_email, a.status from account_identities i
    join accounts a on a.id = i.account_id where i.provider = 'google' and i.provider_subject = $1
  `, [subject]);
  let account = existing.rows[0];
  let created = false;
  if (!account) {
    const emailAccount = await findOrCreateEmailAccount(context, email);
    account = { ...emailAccount.account, status: "active" };
    created = emailAccount.created;
    await context.database.query(`
      insert into account_identities (id, account_id, provider, provider_subject, email, email_normalized, email_verified, last_used_at)
      values ($1,$2,'google',$3,$4,$4,true,now()) on conflict (provider, provider_subject) do update set last_used_at = now()
    `, [randomUUID(), account.id, subject, email]);
    await context.database.query("update accounts set display_name = coalesce(display_name,$2), last_login_at = now() where id = $1", [account.id, user.name ?? null]);
  }
  if (account.status !== "active") throw new HttpError(403, "Cuenta inactiva");
  return issueSession(context, account, request, created, String(stateData.return_to ?? "/"));
}

async function accessResponse(context: AppContext, accountId: string): Promise<any> {
  const account = await context.database.query<{ actor_type: string }>("select actor_type from accounts where id = $1", [accountId]);
  if (!account.rows[0]) throw new HttpError(404, "Cuenta no encontrada");
  return { account_id: accountId, actor_type: account.rows[0].actor_type, ...(await accountAccess(accountId)) };
}

export async function registerAuth(app: FastifyInstance, context: AppContext): Promise<void> {
  app.post("/auth/email/start", async (request, reply) => {
    const email = normalizeEmail(emailSchema.parse(asObject(request.body).email));
    const recent = await context.database.query<{ last_sent_at: Date }>(`
      select last_sent_at from login_challenges where email_normalized = $1 and consumed_at is null order by created_at desc limit 1
    `, [email]);
    if (recent.rows[0]?.last_sent_at && Date.now() - new Date(recent.rows[0].last_sent_at).getTime() < config.AUTH_CODE_MIN_RESEND_SEC * 1000) {
      throw new HttpError(429, "Espera antes de solicitar otro código");
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const challengeId = randomUUID();
    await context.database.query(`
      insert into login_challenges (id, method, email, email_normalized, code_hash, expires_at, max_attempts, last_sent_at, ip, user_agent)
      values ($1,'email_code',$2,$2,$3,now() + ($4 || ' seconds')::interval,$5,now(),$6,$7)
    `, [challengeId, email, hmac(`${challengeId}:${code}`), config.AUTH_CODE_TTL_SEC, config.AUTH_CODE_MAX_ATTEMPTS, request.ip, request.headers["user-agent"] ?? null]);
    await context.database.query(`
      insert into notification_deliveries (template_key, channel, recipient, payload, status)
      values ('login_code','email',$1,$2,$3)
    `, [email, JSON.stringify({ code }), config.NOTIFICATION_DEV_MODE ? "delivered" : "pending"]);
    reply.status(202);
    return { status: "sent", expires_in_sec: config.AUTH_CODE_TTL_SEC, resend_after_sec: config.AUTH_CODE_MIN_RESEND_SEC,
      delivery: config.NOTIFICATION_DEV_MODE ? "dev" : "email", ...(config.AUTH_DEV_RETURN_CODE ? { code } : {}) };
  });

  const verifyEmail = async (request: FastifyRequest) => {
    const body = asObject(request.body);
    const email = normalizeEmail(emailSchema.parse(body.email));
    const code = z.string().length(6).parse(body.code ?? body.token);
    const challenge = await context.database.query<any>(`
      select * from login_challenges where email_normalized = $1 and consumed_at is null order by created_at desc limit 1
    `, [email]);
    const row = challenge.rows[0];
    if (!row || new Date(row.expires_at).getTime() < Date.now()) throw new HttpError(401, "Código inválido o expirado");
    if (row.attempts >= row.max_attempts) throw new HttpError(429, "Demasiados intentos");
    if (!secureEqual(row.code_hash, hmac(`${row.id}:${code}`))) {
      await context.database.query("update login_challenges set attempts = attempts + 1 where id = $1", [row.id]);
      throw new HttpError(401, "Código inválido o expirado");
    }
    await context.database.query("update login_challenges set consumed_at = now() where id = $1", [row.id]);
    const result = await findOrCreateEmailAccount(context, email);
    return issueSession(context, result.account, request, result.created);
  };
  app.post("/auth/email/verify", verifyEmail);
  app.post("/auth/email/consume", verifyEmail);

  app.get("/auth/google/start", async (request) => startGoogle(context, asObject(request.query).return_to));
  app.get("/api/auth/google/start", async (request, reply) => {
    const result = await startGoogle(context, asObject(request.query).return_to);
    return reply.redirect(result.authorization_url);
  });
  app.post("/auth/google/exchange", async (request) => exchangeGoogle(context, request, asObject(request.body)));
  app.post("/auth/google/consume", async (request) => {
    if (request.headers["x-internal-api-key"] !== config.AUTH_INTERNAL_API_KEY) {
      throw new HttpError(401, "Clave interna inválida");
    }
    const body = asObject(request.body);
    const ticket = z.string().min(32).max(128).parse(body.ticket);
    const expectedState = z.string().min(1).max(512).parse(body.state);
    const stored = await context.redis.getdel(`auth:google:handoff:${ticket}`);
    if (!stored) throw new HttpError(401, "Acceso de Google inválido o expirado");

    const handoff = asObject(JSON.parse(stored));
    const state = z.string().min(1).max(512).parse(handoff.state);
    if (!secureEqual(state, expectedState)) throw new HttpError(401, "Estado de Google inválido o expirado");

    const session = asObject(handoff.payload);
    return {
      account_id: z.string().min(1).parse(session.account_id),
      session_id: z.string().min(1).parse(session.session_id),
      access_token: z.string().min(1).parse(session.access_token),
      refresh_token: z.string().min(1).parse(session.refresh_token),
      actor_type: z.string().min(1).parse(session.actor_type),
      expires_in_sec: z.number().positive().parse(session.expires_in_sec),
      session_expires_in_sec: z.number().positive().parse(session.session_expires_in_sec),
      is_new_account: z.boolean().parse(session.is_new_account),
      primary_email: session.primary_email === null ? null : z.string().email().parse(session.primary_email),
      return_to: session.return_to === undefined || session.return_to === null
        ? session.return_to
        : z.string().parse(session.return_to),
    } satisfies AuthResult;
  });
  app.get("/api/auth/google/callback", async (request, reply) => {
    const query = asObject(request.query);
    const state = z.string().min(1).max(512).parse(query.state);
    const payload = await exchangeGoogle(context, request, { ...query, redirect_uri: config.AUTH_GOOGLE_REDIRECT_URI });
    const ticket = randomToken(32);
    await context.redis.set(
      `auth:google:handoff:${ticket}`,
      JSON.stringify({ state, payload }),
      "EX",
      60
    );
    const target = new URL("/api/auth/google/callback", config.AUTH_GOOGLE_FRONTEND_BASE_URL);
    target.searchParams.set("ticket", ticket);
    target.searchParams.set("state", state);
    return reply.header("cache-control", "no-store").redirect(target.toString());
  });

  app.post("/auth/token/refresh", async (request) => {
    const oldToken = z.string().min(32).max(128).parse(asObject(request.body).refresh_token);
    const oldHash = sha256(oldToken);
    const clientId = refreshClientId(request);
    const rotationKey = clientId
      ? `auth:refresh:rotation:${oldHash}:${sha256(clientId)}`
      : null;
    const lockKey = rotationKey ? `${rotationKey}:lock` : null;
    let lockValue: string | null = null;
    let lockAcquired = false;

    if (rotationKey && lockKey) {
      const cached = await readActiveRefreshRotationCache(context, rotationKey);
      if (cached) return cached;

      lockValue = randomToken(24);
      let lockAvailable = true;
      let lockResult: string | null = null;
      try {
        lockResult = await context.redis.set(lockKey, lockValue, "EX", REFRESH_ROTATION_LOCK_TTL_SEC, "NX");
      } catch {
        lockAvailable = false;
      }
      if (lockAvailable && lockResult !== "OK") {
        const waited = await waitForRefreshRotationCache(context, rotationKey);
        if (waited) return waited;
        throw new HttpError(503, "La renovación de sesión está temporalmente ocupada");
      }
      lockAcquired = lockAvailable;
    }

    const refreshToken = randomToken(48);
    try {
      const rotated = await context.database.query<{
        session_id: string;
        account_id: string;
        actor_type: string;
        primary_email: string | null;
        session_expires_in_sec: number;
      }>(`
        update sessions s
        set previous_refresh_token_hash = s.refresh_token_hash,
            refresh_token_hash = $2,
            last_seen_at = now()
        from accounts a
        where s.refresh_token_hash = $1
          and s.revoked_at is null
          and s.expires_at > now()
          and a.id = s.account_id
          and a.status = 'active'
        returning s.id as session_id, s.account_id, a.actor_type, a.primary_email,
          greatest(1, floor(extract(epoch from (s.expires_at - now()))))::int as session_expires_in_sec
      `, [oldHash, sha256(refreshToken)]);
      const session = rotated.rows[0];
      if (session) {
        const result: RefreshResult = {
          account_id: session.account_id,
          session_id: session.session_id,
          actor_type: session.actor_type,
          primary_email: session.primary_email,
          access_token: await signAccessToken({ accountId: session.account_id, actorType: session.actor_type, sessionId: session.session_id }),
          refresh_token: refreshToken,
          expires_in_sec: config.AUTH_ACCESS_TTL_SEC,
          session_expires_in_sec: session.session_expires_in_sec ?? config.AUTH_SESSION_TTL_SEC,
        };
        if (rotationKey) {
          await context.redis.set(rotationKey, JSON.stringify(result), "EX", REFRESH_ROTATION_CACHE_TTL_SEC).catch(() => undefined);
        }
        return result;
      }

      if (rotationKey) {
        const cached = await readActiveRefreshRotationCache(context, rotationKey);
        if (cached) return cached;
      }

      const reused = await context.database.query<{ id: string }>(`
        select id from sessions
        where previous_refresh_token_hash = $1 and revoked_at is null and expires_at > now()
        limit 1
      `, [oldHash]);
      if (reused.rows[0]) {
        await context.database.query(
          "update sessions set revoked_at = now(), revoke_reason = $2 where id = $1 and revoked_at is null",
          [reused.rows[0].id, "refresh_token_reuse"]
        );
      }
      throw new HttpError(401, "Refresh token inválido o expirado");
    } finally {
      if (lockAcquired && lockKey && lockValue) {
        await context.redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          lockKey,
          lockValue
        ).catch(() => undefined);
      }
    }
  });
  app.post("/auth/session/revoke", async (request) => {
    const body = asObject(request.body);
    const requestedSessionId = body.session_id === undefined
      ? undefined
      : z.string().uuid().parse(body.session_id);
    const refreshToken = body.refresh_token === undefined
      ? undefined
      : z.string().min(32).max(128).parse(body.refresh_token);
    const reason = body.reason === undefined
      ? "user_logout"
      : z.string().trim().min(1).max(120).parse(body.reason);
    const token = bearerToken(request);
    let accessSessionId: string | undefined;
    if (token) {
      try {
        accessSessionId = (await verifyAccessToken(token)).sessionId;
      } catch (error) {
        if (!refreshToken) throw error;
      }
    }

    let refreshSessionId: string | undefined;
    if (refreshToken) {
      const refreshSession = await context.database.query<{ id: string }>(
        "select id from sessions where refresh_token_hash = $1 and revoked_at is null limit 1",
        [sha256(refreshToken)]
      );
      refreshSessionId = refreshSession.rows[0]?.id;
    }

    if (accessSessionId && refreshSessionId && accessSessionId !== refreshSessionId) {
      throw new HttpError(403, "Las credenciales no pertenecen a la misma sesión");
    }
    const sessionId = accessSessionId ?? refreshSessionId;
    if (!sessionId) throw new HttpError(401, "Se requiere autenticación");
    if (requestedSessionId && requestedSessionId !== sessionId) {
      throw new HttpError(403, "La sesión no pertenece a las credenciales enviadas");
    }
    const result = await context.database.query("update sessions set revoked_at = now(), revoke_reason = $2 where id = $1 and revoked_at is null", [sessionId, reason]);
    return { revoked: (result.rowCount ?? 0) > 0 };
  });
  app.get("/auth/me", async (request) => {
    const actor = await authenticate(request);
    const result = await context.database.query<any>("select * from accounts where id = $1", [actor.accountId]);
    const account = result.rows[0];
    return { account_id: account.id, session_id: actor.sessionId, actor_type: account.actor_type, status: account.status, display_name: account.display_name,
      primary_email: account.primary_email, roles: actor.roles, permissions: actor.permissions };
  });

  app.post("/internal/validate-token", async (request) => {
    try {
      const actor = await verifyAccessToken(z.string().min(1).parse(asObject(request.body).token));
      return { valid: true, account_id: actor.accountId, session_id: actor.sessionId ?? null, actor_type: actor.actorType, roles: actor.roles, permissions: actor.permissions };
    } catch {
      return { valid: false, account_id: null, session_id: null, actor_type: null };
    }
  });
  app.post("/internal/authorize", async (request) => {
    const body = asObject(request.body);
    try {
      const actor = await verifyAccessToken(String(body.token ?? ""));
      const screen = typeof body.screen === "string" ? body.screen.trim() : "";
      const action = typeof body.action === "string" ? body.action.trim() : "";
      const key = screen && action ? `${screen}:${action}` : "";
      return { allowed: Boolean(key && actor.permissions.includes(key)), account_id: actor.accountId,
        session_id: actor.sessionId ?? null, actor_type: actor.actorType, roles: actor.roles, permissions: actor.permissions };
    } catch {
      return { allowed: false, account_id: null, session_id: null, actor_type: null, roles: [], permissions: [] };
    }
  });
  app.post("/internal/audit-log", async (request, reply) => {
    const body = asObject(request.body);
    await context.database.query(`insert into audit_log (account_id,actor_type,action,resource_type,resource_id,reason,payload,ip,user_agent)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [body.account_id ?? null, body.actor_type ?? "system", body.action,
      body.resource_type, body.resource_id ?? null, body.reason ?? null, body.payload ? JSON.stringify(body.payload) : null, body.ip ?? null, body.user_agent ?? null]);
    reply.status(201); return { created: true };
  });

  app.get("/admin/auth/audit-log", async (request) => {
    const query = asObject(request.query); const values: any[] = []; const where: string[] = [];
    for (const key of ["account_id", "actor_type", "action", "resource_type"]) if (query[key]) { values.push(query[key]); where.push(`${key} = $${values.length}`); }
    values.push(Math.min(Number(query.limit ?? 100), 500));
    return (await context.database.query(`select * from audit_log ${where.length ? `where ${where.join(" and ")}` : ""} order by created_at desc limit $${values.length}`, values)).rows;
  });
  app.get("/admin/auth/accounts", async (request) => {
    const query = asObject(request.query); const values: any[] = []; const where: string[] = [];
    if (query.q) { values.push(`%${query.q}%`); where.push(`(a.primary_email ilike $${values.length} or a.display_name ilike $${values.length})`); }
    for (const key of ["status", "actor_type"]) if (query[key]) { values.push(query[key]); where.push(`a.${key} = $${values.length}`); }
    values.push(Math.min(Number(query.limit ?? 100), 500));
    return (await context.database.query(`
      select a.id as account_id,a.actor_type,a.status,a.display_name,a.primary_email,a.created_at,a.updated_at,a.last_login_at,
        coalesce(array_agg(distinct r.code) filter (where r.code is not null),'{}') as roles
      from accounts a left join account_roles ar on ar.account_id=a.id left join roles r on r.id=ar.role_id
      ${where.length ? `where ${where.join(" and ")}` : ""} group by a.id order by a.created_at desc limit $${values.length}
    `, values)).rows;
  });
  app.get("/admin/auth/roles", async () => (await context.database.query("select code,name,description,is_system from roles order by name")).rows);
  app.get("/admin/auth/permissions", async () => (await context.database.query("select screen,action,description from permissions order by screen,action")).rows);
  app.get<{ Params: { account_id: string } }>("/admin/auth/accounts/:account_id/access", async (request) => accessResponse(context, request.params.account_id));
  app.post<{ Params: { account_id: string } }>("/admin/auth/accounts/:account_id/status", async (request) => {
    const body = asObject(request.body);
    const status = z.string().trim().min(1).max(32).parse(body.status).toLowerCase();
    const reason = body.reason === undefined
      ? "account_status_changed"
      : z.string().trim().min(1).max(120).parse(body.reason);
    const result = await context.database.query<any>(`
      with updated_account as (
        update accounts
        set status=$2,updated_at=now()
        where id=$1
        returning id as account_id,actor_type,status,display_name,primary_email,created_at,updated_at,last_login_at
      ), revoked_sessions as (
        update sessions
        set revoked_at=now(),revoke_reason=$3
        where account_id=$1 and revoked_at is null and $2 <> 'active'
        returning id
      )
      select updated_account.*,(select count(*)::int from revoked_sessions) as revoked_sessions
      from updated_account
    `, [request.params.account_id, status, reason]);
    if (!result.rows[0]) throw new HttpError(404, "Cuenta no encontrada");
    await audit(request, "account.status_updated", "account", request.params.account_id, body); return { ...result.rows[0], roles: (await accountAccess(request.params.account_id)).roles };
  });
  app.post<{ Params: { account_id: string } }>("/admin/auth/accounts/:account_id/roles", async (request) => {
    const code = z.string().min(1).parse(asObject(request.body).role_code);
    await context.database.query(`insert into account_roles(id,account_id,role_id,assigned_by_account_id,expires_at)
      select $1,$2,id,$3,$4 from roles where code=$5 on conflict(account_id,role_id) do update set expires_at=excluded.expires_at`,
    [randomUUID(), request.params.account_id, request.actor?.accountId ?? null, asObject(request.body).expires_at ?? null, code]);
    await audit(request, "account.role_assigned", "account", request.params.account_id, { role_code: code }); return accessResponse(context, request.params.account_id);
  });
  app.delete<{ Params: { account_id: string; role_code: string } }>("/admin/auth/accounts/:account_id/roles/:role_code", async (request) => {
    await context.database.query("delete from account_roles using roles where account_roles.role_id=roles.id and account_roles.account_id=$1 and roles.code=$2", [request.params.account_id, request.params.role_code]);
    await audit(request, "account.role_removed", "account", request.params.account_id, { role_code: request.params.role_code }); return accessResponse(context, request.params.account_id);
  });
  app.post<{ Params: { account_id: string } }>("/admin/auth/accounts/:account_id/permission-overrides", async (request) => {
    const body = asObject(request.body);
    await context.database.query(`insert into account_permission_overrides(id,account_id,permission_id,effect,reason,assigned_by_account_id)
      select $1,$2,id,$3,$4,$5 from permissions where screen=$6 and action=$7
      on conflict(account_id,permission_id) do update set effect=excluded.effect,reason=excluded.reason,updated_at=now()`,
    [randomUUID(), request.params.account_id, body.effect, body.reason ?? null, request.actor?.accountId ?? null, body.screen, body.action]);
    await audit(request, "account.permission_override", "account", request.params.account_id, body); return accessResponse(context, request.params.account_id);
  });
  app.delete<{ Params: { account_id: string; screen: string; action: string } }>("/admin/auth/accounts/:account_id/permission-overrides/:screen/:action", async (request) => {
    await context.database.query(`delete from account_permission_overrides using permissions where account_permission_overrides.permission_id=permissions.id
      and account_permission_overrides.account_id=$1 and permissions.screen=$2 and permissions.action=$3`, [request.params.account_id, request.params.screen, request.params.action]);
    await audit(request, "account.permission_override_removed", "account", request.params.account_id, request.params); return accessResponse(context, request.params.account_id);
  });
}
