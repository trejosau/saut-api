import Fastify from "fastify";
import { beforeEach, expect, it, vi } from "vitest";
import { ZodError } from "zod";
const { database } = vi.hoisted(() => ({ database: { query: vi.fn() } }));
vi.mock("../src/db.js", () => ({ database, closeDatabase: vi.fn(), pingDatabase: vi.fn() }));
import { registerAuth } from "../src/modules/auth.js";
import { signAccessToken } from "../src/platform.js";
const accountId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const addressId = "33333333-3333-4333-8333-333333333333";
const address = { label: "Casa", line1: "Calle 10", city: "Puebla", state: "Puebla", postal_code: "72000", country: "MX" };
beforeEach(() => {
  database.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes("select actor_type, status from accounts")) return { rows: [{ actor_type: "customer", status: "active" }] };
    if (sql.includes("select account_id, revoked_at, expires_at from sessions")) return { rows: [{ account_id: accountId, revoked_at: null, expires_at: new Date(Date.now() + 60000) }] };
    if (sql.includes("select * from accounts")) return { rows: [{ id: accountId, primary_email: "ana@example.com", display_name: "Ana" }] };
    if (sql.includes("select 1 from account_identities")) return { rows: [{ verified: 1 }] };
    if (sql.startsWith("update accounts set display_name")) return { rows: [{ display_name: "Ana" }] };
    if (sql.includes("account_addresses") && !sql.startsWith("delete")) return { rows: [{ id: addressId, ...address }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});
async function app() {
  const server = Fastify();
  server.setErrorHandler((error, _request, reply) => reply.status(error instanceof ZodError ? 400 : Number((error as { statusCode?: number }).statusCode ?? 500)).send({ error: "request failed" }));
  await registerAuth(server, { database } as never);
  return server;
}
async function headers() { return { authorization: `Bearer ${await signAccessToken({ accountId, actorType: "customer", sessionId })}` }; }
it("loads profile and verification from the authenticated account", async () => {
  const server = await app();
  const result = await server.inject({ url: "/auth/me", headers: await headers() });
  expect(result.json()).toMatchObject({ account_id: accountId, display_name: "Ana", email_verified: true });
  await server.close();
});
it.each(["/auth/me", "/auth/me/addresses"])("requires authentication at %s", async url => {
  const server = await app();
  expect((await server.inject({ url })).statusCode).toBe(401);
  expect(database.query).not.toHaveBeenCalled();
  await server.close();
});
it("updates only the session owner and rejects injected account IDs", async () => {
  const server = await app(); const auth = await headers();
  expect((await server.inject({ method: "PATCH", url: "/auth/me", headers: auth, payload: { display_name: "Ana" } })).statusCode).toBe(200);
  expect(database.query).toHaveBeenCalledWith(expect.stringContaining("where id=$1 returning display_name"), [accountId, "Ana"]);
  expect((await server.inject({ method: "PATCH", url: "/auth/me", headers: auth, payload: { display_name: "Ana", account_id: addressId } })).statusCode).toBe(400);
  await server.close();
});
it("lists and adds addresses belonging to the session owner", async () => {
  const server = await app(); const auth = await headers();
  expect((await server.inject({ url: "/auth/me/addresses", headers: auth })).json()).toHaveLength(1);
  expect(database.query).toHaveBeenCalledWith(expect.stringContaining("where account_id=$1"), [accountId]);
  expect((await server.inject({ method: "POST", url: "/auth/me/addresses", headers: auth, payload: address })).statusCode).toBe(201);
  expect(database.query).toHaveBeenCalledWith(expect.stringContaining("insert into account_addresses"), [expect.any(String), accountId, "Casa", "Calle 10", null, "Puebla", "Puebla", "72000", "MX"]);
  expect((await server.inject({ method: "POST", url: "/auth/me/addresses", headers: auth, payload: { ...address, account_id: addressId } })).statusCode).toBe(400);
  expect((await server.inject({ method: "POST", url: "/auth/me/addresses", headers: auth, payload: { ...address, postal_code: "bad" } })).statusCode).toBe(400);
  await server.close();
});
it("updates an address with an ownership predicate", async () => {
  const server = await app();
  expect((await server.inject({ method: "PATCH", url: `/auth/me/addresses/${addressId}`, headers: await headers(), payload: address })).statusCode).toBe(200);
  expect(database.query).toHaveBeenCalledWith(expect.stringContaining("where id=$1 and account_id=$2 returning"), [addressId, accountId, "Casa", "Calle 10", null, "Puebla", "Puebla", "72000", "MX"]);
  await server.close();
});
it.each(["PATCH", "DELETE"] as const)("returns 404 when %s targets another owner's address", async method => {
  const original = database.query.getMockImplementation()!;
  database.query.mockImplementation((sql, ...args) => sql.includes("account_addresses") ? Promise.resolve({ rows: [], rowCount: 0 }) : original(sql, ...args));
  const server = await app();
  expect((await server.inject({ method, url: `/auth/me/addresses/${addressId}`, headers: await headers(), payload: method === "PATCH" ? address : undefined })).statusCode).toBe(404);
  expect(database.query).toHaveBeenCalledWith(expect.stringContaining("where id=$1 and account_id=$2"), expect.arrayContaining([addressId, accountId]));
  await server.close();
});
it("deletes an owned address", async () => {
  const original = database.query.getMockImplementation()!;
  database.query.mockImplementation((sql, ...args) => sql.startsWith("delete from account_addresses") ? Promise.resolve({ rows: [], rowCount: 1 }) : original(sql, ...args));
  const server = await app();
  expect((await server.inject({ method: "DELETE", url: `/auth/me/addresses/${addressId}`, headers: await headers() })).json()).toEqual({ deleted: true });
  await server.close();
});
