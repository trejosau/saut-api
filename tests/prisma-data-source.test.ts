import { beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaDataSource } from "../src/database/prisma-data-source.js";
import { createPoolMock, createPrismaMock } from "./helpers/prisma.js";

describe("PrismaDataSource", () => {
  const prisma = createPrismaMock();
  const pool = createPoolMock();
  const dataSource = new PrismaDataSource("postgres://unused", { client: prisma, pool });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns rows through Prisma for read queries", async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([{ id: "account-1" }]);

    await expect(dataSource.query("select id from accounts where id=$1", ["account-1"]))
      .resolves.toEqual({ rows: [{ id: "account-1" }], rowCount: 1 });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      "select id from accounts where id=$1",
      "account-1"
    );
  });

  it("reports affected rows for writes without returning data", async () => {
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1);

    await expect(dataSource.query("delete from sessions where id=$1", ["session-1"]))
      .resolves.toEqual({ rows: [], rowCount: 1 });
  });

  it("exposes PostgreSQL pool gauges without opening a connection", () => {
    Object.assign(pool, { totalCount: 4, idleCount: 2, waitingCount: 1 });

    expect(dataSource.poolMetrics()).toEqual({
      totalConnections: 4,
      idleConnections: 2,
      waitingRequests: 1,
      maxConnections: 10,
    });
  });

  it("propagates Prisma errors to the application boundary", async () => {
    const error = new Error("database unavailable");
    vi.mocked(prisma.$queryRawUnsafe).mockRejectedValue(error);

    await expect(dataSource.query("select 1")).rejects.toBe(error);
  });

  it("closes Prisma and its shared PostgreSQL pool", async () => {
    await dataSource.close();

    expect(prisma.$disconnect).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
