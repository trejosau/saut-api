import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { z } from "zod";

import { config } from "../config.js";
import { asObject, authenticate, audit, HttpError, secureEqual, sha256 } from "../platform.js";
import type { AppContext, Actor } from "../types.js";
import { issueSession } from "./auth.js";
import { readMfaStatus, recordAuthEvent, requireStepUp } from "./advanced-auth.js";

const passkeyId = z.string().uuid();
const nameSchema = z.string().trim().min(1).max(120);

const registrationResponseSchema = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  response: z.object({
    clientDataJSON: z.string().min(1).max(100_000),
    attestationObject: z.string().min(1).max(100_000),
    transports: z.array(z.string().trim().min(1).max(32)).max(10).optional(),
    authenticatorData: z.string().min(1).max(100_000).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: z.string().max(100_000).optional(),
  }).passthrough(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  type: z.literal("public-key"),
  authenticatorAttachment: z.string().max(32).optional(),
}).passthrough();

const authenticationResponseSchema = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  response: z.object({
    clientDataJSON: z.string().min(1).max(100_000),
    authenticatorData: z.string().min(1).max(100_000),
    signature: z.string().min(1).max(100_000),
    userHandle: z.string().max(1024).optional(),
  }).passthrough(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  type: z.literal("public-key"),
  authenticatorAttachment: z.string().max(32).optional(),
}).passthrough();

const registrationVerifySchema = z.object({
  challenge_id: z.string().uuid(),
  response: registrationResponseSchema,
  name: nameSchema.optional(),
});

const authenticationVerifySchema = z.object({
  challenge_id: z.string().uuid(),
  response: authenticationResponseSchema,
});

type ChallengeRow = {
  id: string;
  challenge: string;
  type: "registration" | "authentication";
  account_id: string | null;
};

type CredentialRow = {
  id: string;
  account_id: string;
  credential_id: string;
  public_key: Uint8Array;
  counter: string | number | bigint;
  transports: string[];
  device_type: string | null;
  backed_up: boolean;
  name: string | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
};

const RATE_LIMIT_SCRIPT = "local count=redis.call('INCR',KEYS[1]);if count==1 then redis.call('EXPIRE',KEYS[1],ARGV[1])end;return count";
const RATE_LIMITS = {
  registrationOptions: { max: 10, windowSec: 60 },
  registrationVerify: { max: 10, windowSec: 60 },
  authenticationOptions: { max: 20, windowSec: 60 },
  authenticationVerify: { max: 30, windowSec: 60 },
  management: { max: 20, windowSec: 60 },
} as const;

function accountUserId(accountId: string): string {
  return Buffer.from(accountId, "utf8").toString("base64url");
}

function counterValue(value: string | number | bigint): number {
  const counter = Number(value);
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("Invalid WebAuthn counter");
  return counter;
}

function webAuthnCredential(row: CredentialRow): WebAuthnCredential {
  return {
    id: row.credential_id,
    publicKey: Buffer.from(row.public_key),
    counter: counterValue(row.counter),
    transports: row.transports,
  };
}

function safeCredentialMetadata(row: Pick<CredentialRow, "id" | "name" | "created_at" | "last_used_at" | "transports" | "device_type" | "backed_up">) {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    transports: row.transports,
    device_type: row.device_type,
    backed_up: row.backed_up,
  };
}

async function rateLimit(context: AppContext, request: FastifyRequest, operation: string, subject: string, policy: { max: number; windowSec: number }): Promise<void> {
  const key = `rate:auth:passkey:${operation}:${sha256(`${request.ip}:${subject}`)}`;
  try {
    const count = Number(await context.redis.eval(
      RATE_LIMIT_SCRIPT,
      1,
      key,
      String(policy.windowSec + 1),
    ));
    if (count > policy.max) throw new HttpError(429, "Demasiadas solicitudes", undefined, "RATE_LIMITED");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (!config.RATE_LIMIT_FAIL_OPEN) throw new HttpError(503, "Rate limit no disponible", undefined, "SERVICE_UNAVAILABLE");
  }
}

async function requireStepUpForPasskey(context: AppContext, request: FastifyRequest): Promise<Actor> {
  const actor = await authenticate(request);
  const status = await readMfaStatus(context, actor);
  requireStepUp(actor, status.policy.step_up_ttl_sec);
  return actor;
}

async function activeAccount(context: AppContext, accountId: string): Promise<{ id: string; actor_type: string; primary_email: string | null; display_name: string | null } | null> {
  const result = await context.database.query<{ id: string; actor_type: string; primary_email: string | null; display_name: string | null }>(
    "select id, actor_type, primary_email, display_name from accounts where id = $1 and status = 'active'",
    [accountId],
  );
  return result.rows[0] ?? null;
}

async function recordFailure(context: AppContext, request: FastifyRequest, eventType: string, accountId?: string | null): Promise<void> {
  await recordAuthEvent(context, request, eventType, { accountId: accountId ?? null });
}

export async function consumeChallenge(client: { query<Row = any>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number | null }> }, id: string, type: ChallengeRow["type"], accountId?: string): Promise<void> {
  const values = accountId === undefined ? [id, type] : [id, type, accountId];
  const accountPredicate = accountId === undefined ? "and account_id is null" : "and account_id = $3";
  const consumed = await client.query<{ id: string }>(
    `update webauthn_challenges set consumed_at = now()
     where id = $1 and type = $2 ${accountPredicate}
       and consumed_at is null and expires_at > now()
     returning id`,
    values,
  );
  if (!consumed.rows[0]) throw new HttpError(401, "Challenge WebAuthn inválido o expirado", undefined, "PASSKEY_CHALLENGE_INVALID");
}

function uniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}

export async function registerPasskeys(app: FastifyInstance, context: AppContext): Promise<void> {
  app.post("/auth/passkeys/register/options", async (request, reply) => {
    const actor = await requireStepUpForPasskey(context, request);
    await rateLimit(context, request, "registration-options", actor.accountId, RATE_LIMITS.registrationOptions);
    const account = await activeAccount(context, actor.accountId);
    if (!account) throw new HttpError(403, "Cuenta inactiva");

    const existing = await context.database.query<{ credential_id: string; transports: string[] }>(
      "select credential_id, transports from webauthn_credentials where account_id = $1 order by created_at",
      [actor.accountId],
    );
    const options = await generateRegistrationOptions({
      rpName: config.WEBAUTHN_RP_NAME,
      rpID: config.WEBAUTHN_RP_ID,
      userID: Buffer.from(accountUserId(actor.accountId), "base64url"),
      userName: account.primary_email ?? `account-${actor.accountId}`,
      userDisplayName: account.display_name ?? account.primary_email ?? "SAUT account",
      challenge: undefined,
      timeout: 60_000,
      attestationType: "none",
      excludeCredentials: existing.rows.map((row) => ({ id: row.credential_id, transports: row.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    const challengeId = randomUUID();
    await context.database.query(
      `insert into webauthn_challenges (id, challenge, type, account_id, expires_at)
       values ($1,$2,'registration',$3,now() + ($4 || ' seconds')::interval)`,
      [challengeId, options.challenge, actor.accountId, config.WEBAUTHN_CHALLENGE_TTL_SEC],
    );
    await recordAuthEvent(context, request, "passkey.registration.started");
    reply.header("cache-control", "no-store");
    return { challenge_id: challengeId, expires_in_sec: config.WEBAUTHN_CHALLENGE_TTL_SEC, options };
  });

  app.post("/auth/passkeys/register/verify", async (request) => {
    const actor = await requireStepUpForPasskey(context, request);
    await rateLimit(context, request, "registration-verify", actor.accountId, RATE_LIMITS.registrationVerify);
    const body = registrationVerifySchema.parse(asObject(request.body));
    const challengeResult = await context.database.query<ChallengeRow>(
      `select id, challenge, type, account_id from webauthn_challenges
       where id = $1 and type = 'registration' and account_id = $2
         and consumed_at is null and expires_at > now()`,
      [body.challenge_id, actor.accountId],
    );
    const challenge = challengeResult.rows[0];
    if (!challenge) {
      await recordFailure(context, request, "passkey.registration.failed", actor.accountId);
      throw new HttpError(401, "Challenge WebAuthn inválido o expirado", undefined, "PASSKEY_CHALLENGE_INVALID");
    }

    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verified = await verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: config.WEBAUTHN_EXPECTED_ORIGIN,
        expectedRPID: config.WEBAUTHN_RP_ID,
        requireUserPresence: true,
        requireUserVerification: false,
      });
    } catch {
      await recordFailure(context, request, "passkey.registration.failed", actor.accountId);
      throw new HttpError(401, "No se pudo validar la passkey", undefined, "PASSKEY_VERIFICATION_FAILED");
    }
    if (!verified.verified) {
      await recordFailure(context, request, "passkey.registration.failed", actor.accountId);
      throw new HttpError(401, "No se pudo validar la passkey", undefined, "PASSKEY_VERIFICATION_FAILED");
    }

    const registration = verified.registrationInfo;
    const credentialId = registration.credential.id;
    const client = await context.database.connect();
    try {
      await client.query("begin");
      await consumeChallenge(client, body.challenge_id, "registration", actor.accountId);
      await client.query(
        `insert into webauthn_credentials
          (id, account_id, credential_id, public_key, counter, transports, device_type, backed_up, name)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [randomUUID(), actor.accountId, credentialId, Buffer.from(registration.credential.publicKey), registration.credential.counter,
          body.response.response.transports ?? [], registration.credentialDeviceType, registration.credentialBackedUp, body.name ?? null],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (uniqueViolation(error)) {
        await recordFailure(context, request, "passkey.registration.failed", actor.accountId);
        throw new HttpError(409, "La passkey ya está registrada", undefined, "PASSKEY_ALREADY_REGISTERED");
      }
      throw error;
    } finally {
      client.release();
    }
    await recordAuthEvent(context, request, "passkey.registration.succeeded");
    return { verified: true, credential_id: credentialId };
  });

  app.post("/auth/passkeys/authenticate/options", async (request, reply) => {
    await rateLimit(context, request, "authentication-options", request.ip, RATE_LIMITS.authenticationOptions);
    const options = await generateAuthenticationOptions({
      rpID: config.WEBAUTHN_RP_ID,
      timeout: 60_000,
      userVerification: "preferred",
    });
    const challengeId = randomUUID();
    await context.database.query(
      `insert into webauthn_challenges (id, challenge, type, expires_at)
       values ($1,$2,'authentication',now() + ($3 || ' seconds')::interval)`,
      [challengeId, options.challenge, config.WEBAUTHN_CHALLENGE_TTL_SEC],
    );
    await recordAuthEvent(context, request, "passkey.authentication.started");
    reply.header("cache-control", "no-store");
    return { challenge_id: challengeId, expires_in_sec: config.WEBAUTHN_CHALLENGE_TTL_SEC, options };
  });

  app.post("/auth/passkeys/authenticate/verify", async (request) => {
    await rateLimit(context, request, "authentication-verify", request.ip, RATE_LIMITS.authenticationVerify);
    const body = authenticationVerifySchema.parse(asObject(request.body));
    const credentialResult = await context.database.query<CredentialRow>(
      `select c.*, a.status as account_status from webauthn_credentials c
       join accounts a on a.id = c.account_id
       where c.credential_id = $1 and a.status = 'active'`,
      [body.response.id],
    );
    const credential = credentialResult.rows[0];
    const challengeResult = await context.database.query<ChallengeRow>(
      `select id, challenge, type, account_id from webauthn_challenges
       where id = $1 and type = 'authentication' and account_id is null
         and consumed_at is null and expires_at > now()`,
      [body.challenge_id],
    );
    const challenge = challengeResult.rows[0];
    if (!credential || !challenge) {
      await recordFailure(context, request, "passkey.authentication.failed", credential?.account_id);
      throw new HttpError(401, "No se pudo validar la passkey", undefined, "PASSKEY_VERIFICATION_FAILED");
    }

    const userHandle = body.response.response.userHandle;
    if (userHandle !== undefined && !secureEqual(userHandle, accountUserId(credential.account_id))) {
      await recordFailure(context, request, "passkey.authentication.failed", credential.account_id);
      throw new HttpError(401, "No se pudo validar la passkey", undefined, "PASSKEY_VERIFICATION_FAILED");
    }

    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verified = await verifyAuthenticationResponse({
        response: body.response as AuthenticationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: config.WEBAUTHN_EXPECTED_ORIGIN,
        expectedRPID: config.WEBAUTHN_RP_ID,
        credential: webAuthnCredential(credential),
        requireUserVerification: false,
      });
    } catch {
      await recordFailure(context, request, "passkey.authentication.failed", credential.account_id);
      throw new HttpError(401, "No se pudo validar la passkey", undefined, "PASSKEY_VERIFICATION_FAILED");
    }
    if (!verified.verified) {
      await recordFailure(context, request, "passkey.authentication.failed", credential.account_id);
      throw new HttpError(401, "No se pudo validar la passkey", undefined, "PASSKEY_VERIFICATION_FAILED");
    }

    const oldCounter = counterValue(credential.counter);
    const newCounter = counterValue(verified.authenticationInfo.newCounter);
    if (newCounter < oldCounter) {
      await recordFailure(context, request, "passkey.authentication.failed", credential.account_id);
      throw new HttpError(401, "La passkey presentó un contador inválido", undefined, "PASSKEY_COUNTER_INVALID");
    }
    const client = await context.database.connect();
    try {
      await client.query("begin");
      await consumeChallenge(client, body.challenge_id, "authentication");
      const updated = await client.query<{ id: string }>(
        `update webauthn_credentials
         set counter = $2, device_type = $3, backed_up = $4, last_used_at = now(), updated_at = now()
         where id = $1 and counter = $5
         returning id`,
        [credential.id, newCounter, verified.authenticationInfo.credentialDeviceType,
          verified.authenticationInfo.credentialBackedUp, oldCounter],
      );
      if (!updated.rows[0]) throw new HttpError(401, "La passkey ya fue utilizada o cambió su contador", undefined, "PASSKEY_COUNTER_INVALID");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      await recordFailure(context, request, "passkey.authentication.failed", credential.account_id);
      if (error instanceof HttpError) throw error;
      throw new HttpError(401, "No se pudo validar la passkey", undefined, "PASSKEY_VERIFICATION_FAILED");
    } finally {
      client.release();
    }

    const account = await activeAccount(context, credential.account_id);
    if (!account) {
      await recordFailure(context, request, "passkey.authentication.failed", credential.account_id);
      throw new HttpError(403, "Cuenta inactiva");
    }
    const session = await issueSession(context, account, request, false);
    await recordAuthEvent(context, request, "passkey.authentication.succeeded", { accountId: account.id, sessionId: session.session_id });
    return session;
  });

  app.get("/auth/passkeys", async (request) => {
    const actor = await authenticate(request);
    await rateLimit(context, request, "management", actor.accountId, RATE_LIMITS.management);
    const credentials = await context.database.query<CredentialRow>(
      `select id, account_id, credential_id, public_key, counter, transports, device_type, backed_up, name,
              created_at, updated_at, last_used_at
       from webauthn_credentials where account_id = $1 order by created_at`,
      [actor.accountId],
    );
    return { credentials: credentials.rows.map(safeCredentialMetadata) };
  });

  app.patch<{ Params: { id: string } }>("/auth/passkeys/:id", async (request) => {
    const actor = await authenticate(request);
    await rateLimit(context, request, "management", actor.accountId, RATE_LIMITS.management);
    const name = nameSchema.parse(asObject(request.body).name);
    const id = passkeyId.parse(request.params.id);
    const updated = await context.database.query<CredentialRow>(
      `update webauthn_credentials set name = $3, updated_at = now()
       where id = $1 and account_id = $2
       returning id, account_id, credential_id, public_key, counter, transports, device_type, backed_up, name,
                 created_at, updated_at, last_used_at`,
      [id, actor.accountId, name],
    );
    if (!updated.rows[0]) throw new HttpError(404, "Passkey no encontrada");
    await recordAuthEvent(context, request, "passkey.renamed", { meta: { passkey_id: id } });
    return safeCredentialMetadata(updated.rows[0]);
  });

  app.delete<{ Params: { id: string } }>("/auth/passkeys/:id", async (request) => {
    const actor = await requireStepUpForPasskey(context, request);
    await rateLimit(context, request, "management", actor.accountId, RATE_LIMITS.management);
    const id = passkeyId.parse(request.params.id);
    const deleted = await context.database.query<{ id: string }>(
      "delete from webauthn_credentials where id = $1 and account_id = $2 returning id",
      [id, actor.accountId],
    );
    if (!deleted.rows[0]) throw new HttpError(404, "Passkey no encontrada");
    await audit(request, "auth.passkey.deleted", "webauthn_credential", id);
    await recordAuthEvent(context, request, "passkey.removed", { meta: { passkey_id: id } });
    return { deleted: true, id };
  });
}
