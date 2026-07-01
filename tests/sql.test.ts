import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../src/database/prisma-data-source.js";
import { deleteRow, insertRow, patchRow } from "../src/sql.js";

function queryable(rows: Record<string, unknown>[] = [], rowCount = rows.length) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount });
  return { client: { query } as unknown as Queryable, query };
}

describe("SQL repository helpers", () => {
  it("inserts only allowed fields and quotes identifiers", async () => {
    const { client, query } = queryable([{ id: "publication-1", title: "Drop" }]);
    await expect(insertRow(client, "publications", {
      id: "publication-1",
      title: "Drop",
      ignored: "no",
    }, ["id", "title"])).resolves.toEqual({ id: "publication-1", title: "Drop" });
    expect(query).toHaveBeenCalledWith(
      'insert into "publications" ("id","title") values ($1,$2) returning *',
      ["publication-1", "Drop"]
    );
  });

  it("rejects empty writes", async () => {
    const { client } = queryable();
    await expect(insertRow(client, "publications", {}, ["title"]))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(patchRow(client, "publications", "id", {}, ["title"]))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("patches existing rows and reports missing rows", async () => {
    const existing = queryable([{ id: "publication-1", title: "Nuevo" }]);
    await expect(patchRow(existing.client, "publications", "publication-1", { title: "Nuevo" }, ["title"]))
      .resolves.toEqual({ id: "publication-1", title: "Nuevo" });
    expect(existing.query.mock.calls[0]?.[0]).toContain("updated_at=now()");

    const missing = queryable([]);
    await expect(patchRow(missing.client, "publications", "missing", { title: "Nuevo" }, ["title"]))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("deletes existing rows and rejects missing rows", async () => {
    await expect(deleteRow(queryable([], 1).client, "publications", "publication-1")).resolves.toBeUndefined();
    await expect(deleteRow(queryable([], 0).client, "publications", "missing"))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
