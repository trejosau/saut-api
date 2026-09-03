import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { config } from "../config.js";
import { asObject, authenticate, HttpError, redactSensitive, secureEqual, sha256 } from "../platform.js";
import type { AppContext, Actor } from "../types.js";

const CODE_LENGTH = 6;
const RECOVERY_CODE_PATTERN = /^(?:[A-F0-9]{4}-?){4}[A-F0-9]{4}$/i;
const policyMode = z.enum(["disabled", "optional", "required_all", "required_roles"]);

type MfaRecord = {
  enabled: boolean;
  pending_secret_encrypted: string | null;
  secret_encrypted: string | null;
  last_totp_step: string | number | bigint | null;
};

type MfaPolicy = {
  mode: "disabled" | "optional" | "required_all" | "required_roles";
  required_roles: string[];
  step_up_ttl_sec: number;
};

const encryptionKey = createHash("sha256").update(`saut:mfa:${config.AUTH_TOKEN_SECRET}`).digest();

function base32AlphabetIndex(character: string): number {
  const value = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character);
  if (value < 0) throw new Error("Invalid base32 secret");
  return value;
}

export function encodeBase32(input: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of input) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) output += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(buffer << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(value: string): Buffer {
  const normalized = value.replaceAll(/\s|-/g, "").toUpperCase();
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) throw new Error("Invalid base32 secret");
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    buffer = (buffer << 5) | base32AlphabetIndex(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function totpStep(timestampMs = Date.now()): number {
  return Math.floor(timestampMs / 30_000);
}

export function generateTotpCode(secret: string, step = totpStep()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = (((digest[offset] ?? 0) & 0x7f) << 24)
    | (((digest[offset + 1] ?? 0) & 0xff) << 16)
    | (((digest[offset + 2] ?? 0) & 0xff) << 8)
    | ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 1_000_000).padStart(CODE_LENGTH, "0");
}

export function verifyTotpCode(secret: string, code: string, timestampMs = Date.now(), window = config.AUTH_MFA_TOTP_WINDOW): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(timestampMs);
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (step >= 0 && secureEqual(generateTotpCode(secret, step), code)) return step;
  }
  return null;
}

export function encryptTotpSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptTotpSecret(value: string): string {
  const [ivRaw, tagRaw, ciphertextRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !ciphertextRaw) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]).toString("utf8");
}

export function normalizeRecoveryCode(value: string): string {
  return value.replaceAll("-", "").replaceAll(/\s/g, "").toUpperCase();
}

export function generateRecoveryCodes(count = config.AUTH_MFA_RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(10).toString("hex").toUpperCase();
    return raw.match(/.{1,4}/g)?.join("-") ?? raw;
  });
}

export function isRecoveryCode(value: string): boolean {
  return RECOVERY_CODE_PATTERN.test(value.trim());
}

export function requiresMfa(policy: MfaPolicy, roles: string[]): boolean {
  if (policy.mode === "required_all") return true;
  return policy.mode === "required_roles" && roles.some((role) => policy.required_roles.includes(role));
}

export function requireStepUp(actor: Actor, maxAgeSec = config.AUTH_MFA_STEP_UP_TTL_SEC): void {
  const verifiedAt = actor.stepUpVerifiedAt instanceof Date ? actor.stepUpVerifiedAt.getTime() : Number.NaN;
  if (!Number.isFinite(verifiedAt) || verifiedAt <= Date.now() - maxAgeSec * 1000) {
    throw new HttpError(403, "Se requiere step-up authentication", undefined, "STEP_UP_REQUIRED");
  }
}

export async function recordAuthEvent(
  context: AppContext,
  request: FastifyRequest,
  eventType: string,
  options: { accountId?: string | null; sessionId?: string | null; email?: string | null; meta?: unknown } = {}
): Promise<void> {
  try {
    await context.database.query(`
      insert into auth_events (id, event_type, account_id, session_id, email_normalized, ip, user_agent, meta)
      values ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [randomUUID(), eventType, options.accountId ?? request.actor?.accountId ?? null,
      options.sessionId ?? request.actor?.sessionId ?? null, options.email ?? null, request.ip,
      request.headers["user-agent"] ?? null, options.meta === undefined ? null : JSON.stringify(redactSensitive(options.meta))]);
  } catch {
    // Authentication must remain available if audit persistence is temporarily unavailable.
  }
}

async function mfaRecord(context: AppContext, accountId: string): Promise<MfaRecord | null> {
  const result = await context.database.query<MfaRecord>(
    "select enabled, pending_secret_encrypted, secret_encrypted, last_totp_step from account_mfa where account_id = $1",
    [accountId]
  );
  return result.rows[0] ?? null;
}

async function mfaPolicy(context: AppContext): Promise<MfaPolicy> {
  const result = await context.database.query<MfaPolicy>(
    "select mode, required_roles, step_up_ttl_sec from mfa_policy where id = 1"
  );
  const row = result.rows[0];
  return {
    mode: policyMode.parse(row?.mode ?? "optional"),
    required_roles: Array.isArray(row?.required_roles) ? row.required_roles : [],
    step_up_ttl_sec: Math.min(Math.max(Number(row?.step_up_ttl_sec ?? config.AUTH_MFA_STEP_UP_TTL_SEC), 60), 3600),
  };
}

async function recoveryCodesRemaining(context: AppContext, accountId: string): Promise<number> {
  const result = await context.database.query<{ count: number | string }>(
    "select count(*)::int as count from recovery_codes where account_id = $1 and used_at is null",
    [accountId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function readMfaStatus(context: AppContext, actor: Actor) {
  const [record, policy, remaining] = await Promise.all([
    mfaRecord(context, actor.accountId),
    mfaPolicy(context),
    recoveryCodesRemaining(context, actor.accountId),
  ]);
  const enabled = Boolean(record?.enabled && record.secret_encrypted);
  return {
    enabled,
    setup_pending: Boolean(record?.pending_secret_encrypted),
    required: requiresMfa(policy, actor.roles),
    verified: Boolean(actor.mfaVerifiedAt),
    step_up_verified: actor.stepUpVerifiedAt instanceof Date && actor.stepUpVerifiedAt.getTime() > Date.now() - policy.step_up_ttl_sec * 1000,
    recovery_codes_remaining: remaining,
    methods: enabled ? ["totp", "recovery_code"] : [],
    policy: { mode: policy.mode, required_roles: policy.required_roles, step_up_ttl_sec: policy.step_up_ttl_sec },
  };
}

async function actorForMfa(request: FastifyRequest): Promise<Actor> {
  return authenticate(request, { allowMfaPending: true });
}

async function verifyFactor(context: AppContext, actor: Actor, code: string | undefined, recoveryCode: string | undefined): Promise<"totp" | "recovery_code"> {
  const record = await mfaRecord(context, actor.accountId);
  if (!record?.enabled || !record.secret_encrypted) throw new HttpError(409, "MFA no está configurado", undefined, "MFA_NOT_CONFIGURED");

  if (code !== undefined) {
    const step = (() => {
      try { return verifyTotpCode(decryptTotpSecret(record.secret_encrypted), code); } catch { return null; }
    })();
    if (step === null) throw new HttpError(401, "Código MFA inválido", undefined, "MFA_CODE_INVALID");
    const used = await context.database.query(
      `update account_mfa set last_totp_step = $2, updated_at = now()
       where account_id = $1 and enabled = true and (last_totp_step is null or last_totp_step < $2) returning account_id`,
      [actor.accountId, step]
    );
    if (!used.rows[0]) throw new HttpError(401, "Código MFA ya utilizado", undefined, "MFA_CODE_REPLAYED");
    return "totp";
  }

  if (!recoveryCode || !isRecoveryCode(recoveryCode)) {
    throw new HttpError(401, "Se requiere un código MFA", undefined, "MFA_CODE_REQUIRED");
  }
  const consumed = await context.database.query(
    `update recovery_codes set used_at = now()
     where account_id = $1 and code_hash = $2 and used_at is null returning id`,
    [actor.accountId, sha256(normalizeRecoveryCode(recoveryCode))]
  );
  if (!consumed.rows[0]) throw new HttpError(401, "Código de recuperación inválido o ya utilizado", undefined, "RECOVERY_CODE_INVALID");
  return "recovery_code";
}

function codeInput(body: Record<string, unknown>): { code?: string; recoveryCode?: string } {
  const code = body.code === undefined ? undefined : z.string().length(CODE_LENGTH).parse(body.code);
  const recoveryCode = body.recovery_code === undefined ? undefined : z.string().trim().min(8).max(64).parse(body.recovery_code);
  if ((code === undefined) === (recoveryCode === undefined)) throw new HttpError(422, "Envía code o recovery_code, pero no ambos");
  return { code, recoveryCode };
}

export async function registerAdvancedAuth(app: FastifyInstance, context: AppContext): Promise<void> {
  app.get("/auth/mfa/status", async (request) => readMfaStatus(context, await actorForMfa(request)));
  app.get("/auth/mfa/policy", async (request) => {
    const actor = await actorForMfa(request);
    const policy = await mfaPolicy(context);
    return { mode: policy.mode, required_roles: policy.required_roles, step_up_ttl_sec: policy.step_up_ttl_sec, required: requiresMfa(policy, actor.roles) };
  });

  app.post("/auth/mfa/totp/setup", async (request) => {
    const actor = await actorForMfa(request);
    const current = await mfaRecord(context, actor.accountId);
    if (current?.enabled) throw new HttpError(409, "MFA ya está configurado", undefined, "MFA_ALREADY_CONFIGURED");
    const secret = generateTotpSecret();
    await context.database.query(`
      insert into account_mfa (account_id, pending_secret_encrypted, enabled)
      values ($1,$2,false)
      on conflict (account_id) do update set pending_secret_encrypted = excluded.pending_secret_encrypted, updated_at = now()
    `, [actor.accountId, encryptTotpSecret(secret)]);
    await recordAuthEvent(context, request, "mfa.totp.setup_started", { meta: { account_id: actor.accountId } });
    const account = await context.database.query<{ primary_email: string | null }>("select primary_email from accounts where id = $1", [actor.accountId]);
    const label = account.rows[0]?.primary_email ?? actor.accountId;
    const issuer = encodeURIComponent("SAUT");
    return {
      type: "totp",
      secret,
      otpauth_uri: `otpauth://totp/${issuer}:${encodeURIComponent(label)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
      expires_in_sec: 600,
    };
  });

  app.post("/auth/mfa/totp/verify", async (request) => {
    const actor = await actorForMfa(request);
    const code = z.string().length(CODE_LENGTH).parse(asObject(request.body).code);
    const record = await mfaRecord(context, actor.accountId);
    if (!record?.pending_secret_encrypted || record.enabled) throw new HttpError(409, "No hay una configuración TOTP pendiente");
    const step = (() => {
      try { return verifyTotpCode(decryptTotpSecret(record.pending_secret_encrypted), code); } catch { return null; }
    })();
    if (step === null) {
      await recordAuthEvent(context, request, "mfa.totp.verification_failed", { meta: { account_id: actor.accountId } });
      throw new HttpError(401, "Código MFA inválido", undefined, "MFA_CODE_INVALID");
    }

    const recoveryCodes = generateRecoveryCodes();
    const client = await context.database.connect();
    try {
      await client.query("begin");
      const confirmed = await client.query(
        `update account_mfa set secret_encrypted = pending_secret_encrypted, pending_secret_encrypted = null,
         enabled = true, last_totp_step = $2, confirmed_at = now(), recovery_codes_generated_at = now(), updated_at = now()
         where account_id = $1 and enabled = false and pending_secret_encrypted is not null returning account_id`,
        [actor.accountId, step]
      );
      if (!confirmed.rows[0]) throw new HttpError(409, "La configuración MFA cambió; inténtalo de nuevo");
      await client.query("delete from recovery_codes where account_id = $1", [actor.accountId]);
      for (const recoveryCode of recoveryCodes) {
        await client.query("insert into recovery_codes (id, account_id, code_hash) values ($1,$2,$3)", [randomUUID(), actor.accountId, sha256(normalizeRecoveryCode(recoveryCode))]);
      }
      await client.query("update sessions set mfa_verified_at = now() where id = $1 and account_id = $2", [actor.sessionId, actor.accountId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await recordAuthEvent(context, request, "mfa.totp.enabled", { meta: { account_id: actor.accountId } });
    return { enabled: true, recovery_codes: recoveryCodes };
  });

  app.post("/auth/step-up/start", async (request) => {
    const actor = await actorForMfa(request);
    const purpose = z.string().trim().min(1).max(120).parse(asObject(request.body).purpose);
    const status = await readMfaStatus(context, actor);
    if (!status.enabled) throw new HttpError(409, "Configura MFA antes de solicitar step-up", undefined, "MFA_NOT_CONFIGURED");
    const challengeId = randomBytes(24).toString("base64url");
    const ttl = status.policy.step_up_ttl_sec;
    await context.redis.set(`auth:step-up:${challengeId}`, JSON.stringify({ account_id: actor.accountId, session_id: actor.sessionId, purpose }), "EX", ttl);
    return { challenge_id: challengeId, expires_in_sec: ttl, methods: status.methods };
  });

  app.post("/auth/step-up/verify", async (request) => {
    const actor = await actorForMfa(request);
    const body = asObject(request.body);
    const challengeId = z.string().min(20).max(128).parse(body.challenge_id);
    const stored = await context.redis.getdel(`auth:step-up:${challengeId}`);
    if (!stored) throw new HttpError(401, "Challenge de step-up inválido o expirado", undefined, "STEP_UP_EXPIRED");
    const challenge = asObject(JSON.parse(stored));
    if (challenge.account_id !== actor.accountId || challenge.session_id !== actor.sessionId) {
      throw new HttpError(403, "El challenge no pertenece a la sesión");
    }
    const { code, recoveryCode } = codeInput(body);
    let method: "totp" | "recovery_code";
    try {
      method = await verifyFactor(context, actor, code, recoveryCode);
    } catch (error) {
      await recordAuthEvent(context, request, "step_up.failed", { meta: { purpose: challenge.purpose } });
      throw error;
    }
    await context.database.query(
      `update sessions set mfa_verified_at = coalesce(mfa_verified_at, now()), step_up_verified_at = now(), step_up_method = $2
       where id = $1 and account_id = $3 and revoked_at is null`,
      [actor.sessionId, method, actor.accountId]
    );
    await recordAuthEvent(context, request, "step_up.succeeded", { meta: { purpose: challenge.purpose, method } });
    return { verified: true, method, purpose: challenge.purpose, expires_in_sec: (await mfaPolicy(context)).step_up_ttl_sec };
  });

  app.post("/auth/mfa/disable", async (request) => {
    const actor = await actorForMfa(request);
    const { code, recoveryCode } = codeInput(asObject(request.body));
    const method = await verifyFactor(context, actor, code, recoveryCode);
    await context.database.query("update account_mfa set enabled = false, pending_secret_encrypted = null, secret_encrypted = null, last_totp_step = null, updated_at = now() where account_id = $1", [actor.accountId]);
    await context.database.query("delete from recovery_codes where account_id = $1", [actor.accountId]);
    await context.database.query("update sessions set mfa_verified_at = null, step_up_verified_at = null, step_up_method = null where account_id = $1", [actor.accountId]);
    await recordAuthEvent(context, request, "mfa.disabled", { meta: { method } });
    return { enabled: false };
  });

  app.post("/auth/mfa/recovery-codes/regenerate", async (request) => {
    const actor = await actorForMfa(request);
    const { code, recoveryCode } = codeInput(asObject(request.body));
    const method = await verifyFactor(context, actor, code, recoveryCode);
    const recoveryCodes = generateRecoveryCodes();
    const client = await context.database.connect();
    try {
      await client.query("begin");
      await client.query("delete from recovery_codes where account_id = $1", [actor.accountId]);
      for (const recoveryCodeValue of recoveryCodes) {
        await client.query("insert into recovery_codes (id, account_id, code_hash) values ($1,$2,$3)", [randomUUID(), actor.accountId, sha256(normalizeRecoveryCode(recoveryCodeValue))]);
      }
      await client.query("update account_mfa set recovery_codes_generated_at = now(), updated_at = now() where account_id = $1 and enabled = true", [actor.accountId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await recordAuthEvent(context, request, "mfa.recovery_codes.regenerated", { meta: { method } });
    return { recovery_codes: recoveryCodes };
  });

  app.get("/admin/auth/mfa-policy", async () => mfaPolicy(context));
  app.put("/admin/auth/mfa-policy", async (request) => {
    const actor = request.actor ?? await authenticate(request);
    requireStepUp(actor);
    const body = asObject(request.body);
    const mode = policyMode.parse(body.mode);
    const requiredRoles = z.array(z.string().trim().min(1).max(64)).max(50).parse(body.required_roles ?? []);
    if (mode !== "required_roles" && requiredRoles.length > 0) throw new HttpError(422, "required_roles solo aplica a required_roles");
    const stepUpTtl = body.step_up_ttl_sec === undefined
      ? config.AUTH_MFA_STEP_UP_TTL_SEC
      : z.coerce.number().int().min(60).max(3600).parse(body.step_up_ttl_sec);
    const result = await context.database.query<MfaPolicy>(
      `insert into mfa_policy (id, mode, required_roles, step_up_ttl_sec, updated_by_account_id, updated_at)
       values (1,$1,$2,$3,$4,now())
       on conflict (id) do update set mode=excluded.mode, required_roles=excluded.required_roles,
       step_up_ttl_sec=excluded.step_up_ttl_sec, updated_by_account_id=excluded.updated_by_account_id, updated_at=now()
       returning mode, required_roles, step_up_ttl_sec`,
      [mode, requiredRoles, stepUpTtl, actor.accountId]
    );
    await recordAuthEvent(context, request, "mfa.policy.updated", { meta: { mode, required_roles: requiredRoles } });
    return result.rows[0];
  });

  app.get("/admin/auth/events", async (request) => {
    const query = asObject(request.query);
    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);
    const values: unknown[] = [];
    const where: string[] = [];
    if (query.event_type) { values.push(z.string().max(120).parse(query.event_type)); where.push(`event_type = $${values.length}`); }
    if (query.account_id) { values.push(z.string().uuid().parse(query.account_id)); where.push(`account_id = $${values.length}`); }
    values.push(limit);
    return (await context.database.query(`select id,event_type,account_id,session_id,email_normalized,ip,user_agent,meta,created_at from auth_events ${where.length ? `where ${where.join(" and ")}` : ""} order by created_at desc limit $${values.length}`, values)).rows;
  });
}
