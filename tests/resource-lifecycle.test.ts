import { describe, expect, it, vi } from "vitest";

import { closeAppContext } from "../src/platform.js";
import type { AppContext } from "../src/types.js";

describe("application resource lifecycle", () => {
  it("closes sockets, external clients and the database once", async () => {
    const socket = { close: vi.fn() };
    const context = {
      database: { close: vi.fn().mockResolvedValue(undefined) },
      redis: { disconnect: vi.fn() },
      s3: { destroy: vi.fn() },
      stripe: {},
      sockets: new Set([socket]),
    } as unknown as AppContext;

    await closeAppContext(context);
    await closeAppContext(context);

    expect(socket.close).toHaveBeenCalledOnce();
    expect(context.sockets.size).toBe(0);
    expect(context.redis.disconnect).toHaveBeenCalledOnce();
    expect(context.s3.destroy).toHaveBeenCalledOnce();
    expect(context.database.close).toHaveBeenCalledOnce();
  });
});
