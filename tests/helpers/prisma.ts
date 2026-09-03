import type pg from "pg";
import { vi } from "vitest";

import type { PrismaClient } from "../../generated/prisma/client.js";

export function createPrismaMock() {
  return {
    $queryRawUnsafe: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  } as unknown as PrismaClient;
}

export function createPoolMock() {
  return {
    connect: vi.fn(),
    end: vi.fn(),
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  } as unknown as pg.Pool;
}
