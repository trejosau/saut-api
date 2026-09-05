import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerCatalog } from "../src/modules/catalog.js";
it.each([["collections", "collections_sets", "collection_set_items", "collection"], ["drops", "drops", "drop_items", "drop"]])("returns the %s detail contract with memberships including hidden publications", async (route, table, membership, key) => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "id", title: "Title" }] }).mockResolvedValueOnce({ rows: [{ id: "publication", visibility: "hidden" }] });
  const server = Fastify(); await registerCatalog(server, { database: { query } } as never);
  const result = await server.inject(`/admin/catalog/${route}/id`);
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({ id: "id", [key]: { id: "id" }, items: [{ id: "publication" }] });
  expect(query.mock.calls[0]?.[0]).toContain(`from ${table}`);
  expect(query.mock.calls[1]?.[0]).toContain(`join ${membership}`);
  expect(query.mock.calls[1]?.[0]).not.toContain("p.is_active=true");
  await server.close();
});
it("returns 404 for a deleted collection", async () => {
  const server = Fastify(); await registerCatalog(server, { database: { query: vi.fn().mockResolvedValue({ rows: [] }) } } as never);
  expect((await server.inject("/admin/catalog/collections/missing")).statusCode).toBe(404);
  await server.close();
});
