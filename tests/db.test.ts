import { describe, expect, it, vi } from "vitest";

const databaseLifecycle = vi.hoisted(() => ({
  ping: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));

vi.mock("../src/database/prisma-data-source.js", () => ({
  database: databaseLifecycle,
  prisma: {},
  PrismaDataSource: class PrismaDataSource {},
}));

import { closeDatabase, pingDatabase } from "../src/db.js";

describe("database lifecycle facade", () => {
  it("delegates readiness and shutdown to the data source", async () => {
    await expect(pingDatabase()).resolves.toBeUndefined();
    await expect(closeDatabase()).resolves.toBeUndefined();
    expect(databaseLifecycle.ping).toHaveBeenCalledOnce();
    expect(databaseLifecycle.close).toHaveBeenCalledOnce();
  });
});
