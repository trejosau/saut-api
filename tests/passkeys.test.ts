import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  audit: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  issueSession: vi.fn(),
  readMfaStatus: vi.fn(),
  recordAuthEvent: vi.fn(),
}));

vi.mock("../src/platform.js", async () => {
  const actual = await vi.importActual<typeof import("../src/platform.js")>("../src/platform.js");
  return { ...actual, authenticate: mocks.authenticate, audit: mocks.audit };
});

vi.mock("../src/modules/advanced-auth.js", async () => {
  const actual = await vi.importActual<typeof import("../src/modules/advanced-auth.js")>("../src/modules/advanced-auth.js");
  return { ...actual, readMfaStatus: mocks.readMfaStatus, recordAuthEvent: mocks.recordAuthEvent };
});

vi.mock("../src/modules/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../src/modules/auth.js")>("../src/modules/auth.js");
  return { ...actual, issueSession: mocks.issueSession };
});

vi.mock("@simplewebauthn/server", () => ({
  generateAuthenticationOptions: mocks.generateAuthenticationOptions,
  generateRegistrationOptions: mocks.generateRegistrationOptions,
  verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
  verifyRegistrationResponse: mocks.verifyRegistrationResponse,
}));

import { registerPasskeys, consumeChallenge } from "../src/modules/passkeys.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const credentialRecordId = "22222222-2222-4222-8222-222222222222";
const challengeId = "33333333-3333-4333-8333-333333333333";
const authenticationChallengeId = "44444444-4444-4444-8444-444444444444";

function context(database: Record<string, unknown>, redis = { eval: vi.fn().mockResolvedValue(1) }) {
  return {
    database,
    redis,
    s3: {},
    stripe: {},
    sockets: new Set(),
  } as never;
}

async function app(database: Record<string, unknown>, redis = { eval: vi.fn().mockResolvedValue(1) }) {
  const server = Fastify({ logger: false });
  server.setErrorHandler((error, _request, reply) => {
    reply.status(Number((error as { statusCode?: number }).statusCode ?? 500)).send({ error });
  });
  await registerPasskeys(server, context(database, redis));
  return server;
}

const actor = {
  accountId,
  actorType: "customer",
  sessionId: "55555555-5555-4555-8555-555555555555",
  roles: ["customer"],
  permissions: [],
  stepUpVerifiedAt: new Date(),
};

const registrationResponse = {
  id: "credential-public-id",
  rawId: "credential-public-id",
  response: {
    clientDataJSON: "client-data",
    attestationObject: "attestation",
    transports: ["internal"],
  },
  clientExtensionResults: {},
  type: "public-key",
};

const authenticationResponse = {
  id: "credential-public-id",
  rawId: "credential-public-id",
  response: {
    clientDataJSON: "client-data",
    authenticatorData: "authenticator-data",
    signature: "signature",
  },
  clientExtensionResults: {},
  type: "public-key",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue(actor);
  mocks.readMfaStatus.mockResolvedValue({ policy: { step_up_ttl_sec: 300 } });
  mocks.recordAuthEvent.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue(undefined);
  mocks.generateRegistrationOptions.mockResolvedValue({ challenge: "registration-challenge", rp: { id: "localhost" } });
  mocks.generateAuthenticationOptions.mockResolvedValue({ challenge: "authentication-challenge", rpId: "localhost" });
  mocks.verifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: { id: "credential-public-id", publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  });
  mocks.verifyAuthenticationResponse.mockResolvedValue({
    verified: true,
    authenticationInfo: {
      newCounter: 4,
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  });
  mocks.issueSession.mockResolvedValue({ account_id: accountId, session_id: "session-id", access_token: "access", refresh_token: "refresh" });
});

describe("passkey routes", () => {
  it("creates a registration challenge only after authenticated step-up", async () => {
    const database = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: accountId, actor_type: "customer", primary_email: "user@example.com", display_name: "User" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) };
    const server = await app(database);
    const response = await server.inject({ method: "POST", url: "/auth/passkeys/register/options", payload: {} });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ challenge_id: expect.any(String), expires_in_sec: 300, options: { challenge: "registration-challenge" } });
    expect(mocks.readMfaStatus).toHaveBeenCalledOnce();
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(expect.objectContaining({
      rpID: "localhost",
      authenticatorSelection: expect.objectContaining({ residentKey: "preferred" }),
    }));
  });

  it("verifies registration cryptographically before consuming and storing the credential", async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: challengeId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }), release: vi.fn() };
    const database = { query: vi.fn().mockResolvedValueOnce({ rows: [{ id: challengeId, challenge: "registration-challenge", type: "registration", account_id: accountId }], rowCount: 1 }), connect: vi.fn().mockResolvedValue(client) };
    const server = await app(database);
    const response = await server.inject({ method: "POST", url: "/auth/passkeys/register/verify", payload: { challenge_id: challengeId, response: registrationResponse, name: "Laptop" } });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ verified: true, credential_id: "credential-public-id" });
    expect(mocks.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({ expectedChallenge: "registration-challenge", expectedOrigin: "http://localhost:4200", expectedRPID: "localhost" }));
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("consumed_at = now()"), [challengeId, "registration", accountId]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("insert into webauthn_credentials"), expect.arrayContaining([accountId, "credential-public-id"]));
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("issues the existing session contract and atomically advances the authenticator counter", async () => {
    const credential = {
      id: credentialRecordId,
      account_id: accountId,
      credential_id: "credential-public-id",
      public_key: new Uint8Array([1, 2, 3]),
      counter: 3,
      transports: ["internal"],
      device_type: "singleDevice",
      backed_up: false,
      name: "Laptop",
      created_at: new Date(),
      updated_at: new Date(),
      last_used_at: null,
    };
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: authenticationChallengeId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: credentialRecordId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }), release: vi.fn() };
    const database = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [credential], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: authenticationChallengeId, challenge: "authentication-challenge", type: "authentication", account_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: accountId, actor_type: "customer", primary_email: "user@example.com", display_name: "User" }], rowCount: 1 }), connect: vi.fn().mockResolvedValue(client) };
    const server = await app(database);
    const response = await server.inject({ method: "POST", url: "/auth/passkeys/authenticate/verify", payload: { challenge_id: authenticationChallengeId, response: authenticationResponse } });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ account_id: accountId, session_id: "session-id" });
    expect(mocks.issueSession).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("where id = $1 and counter = $5"), [credentialRecordId, 4, "singleDevice", false, 3]);
    expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({ expectedChallenge: "authentication-challenge", expectedOrigin: "http://localhost:4200", expectedRPID: "localhost", credential: expect.objectContaining({ counter: 3 }) }));
  });

  it("rejects a user handle belonging to another account before signature verification", async () => {
    const database = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ account_id: accountId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: authenticationChallengeId, challenge: "authentication-challenge", type: "authentication", account_id: null }], rowCount: 1 }) };
    const server = await app(database);
    const response = await server.inject({ method: "POST", url: "/auth/passkeys/authenticate/verify", payload: { challenge_id: authenticationChallengeId, response: { ...authenticationResponse, response: { ...authenticationResponse.response, userHandle: "wrong-account" } } } });
    await server.close();

    expect(response.statusCode).toBe(401);
    expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("rejects an authenticator counter rollback before changing persistence", async () => {
    mocks.verifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: {
        newCounter: 2,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });
    const credential = {
      id: credentialRecordId,
      account_id: accountId,
      credential_id: "credential-public-id",
      public_key: new Uint8Array([1, 2, 3]),
      counter: 3,
      transports: ["internal"],
      device_type: "singleDevice",
      backed_up: false,
      name: "Laptop",
      created_at: new Date(),
      updated_at: new Date(),
      last_used_at: null,
    };
    const database = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [credential], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: authenticationChallengeId, challenge: "authentication-challenge", type: "authentication", account_id: null }], rowCount: 1 }), connect: vi.fn() };
    const server = await app(database);
    const response = await server.inject({ method: "POST", url: "/auth/passkeys/authenticate/verify", payload: { challenge_id: authenticationChallengeId, response: authenticationResponse } });
    await server.close();

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("PASSKEY_COUNTER_INVALID");
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rate-limits authenticated credential listing", async () => {
    const redis = { eval: vi.fn().mockResolvedValue(1) };
    const database = { query: vi.fn().mockResolvedValue({
      rows: [{
        id: credentialRecordId,
        account_id: accountId,
        credential_id: "credential-public-id",
        public_key: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ["internal"],
        device_type: "singleDevice",
        backed_up: false,
        name: "Laptop",
        created_at: new Date(),
        updated_at: new Date(),
        last_used_at: null,
      }],
      rowCount: 1,
    }) };
    const server = await app(database, redis);

    const response = await server.inject({ method: "GET", url: "/auth/passkeys" });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, expect.stringContaining("rate:auth:passkey:management:"), "61");
  });
});

describe("challenge replay protection", () => {
  it("allows only one concurrent consumer through the atomic predicate", async () => {
    let consumed = false;
    const client = {
      query: vi.fn(async () => {
        if (consumed) return { rows: [], rowCount: 0 };
        consumed = true;
        return { rows: [{ id: challengeId }], rowCount: 1 };
      }),
    };
    const results = await Promise.allSettled([
      consumeChallenge(client as never, challengeId, "authentication"),
      consumeChallenge(client as never, challengeId, "authentication"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("consumed_at is null and expires_at > now()"), [challengeId, "authentication"]);
  });
});
