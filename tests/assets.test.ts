import { Readable } from "node:stream";

import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { ASSET_MAX_BYTES, registerAssets, validateAssetUpload } from "../src/modules/assets.js";

describe("asset upload policy", () => {
  it("normalizes MIME/category and accepts configured values", () => {
    expect(validateAssetUpload({ contentType: "IMAGE/PNG; charset=binary", category: "DTF" })).toEqual({ contentType: "image/png", category: "dtf" });
  });

  it("rejects unsupported formats and oversized payloads with stable status codes", () => {
    expect(() => validateAssetUpload({ contentType: "text/plain" })).toThrowError(/Tipo de archivo/);
    try {
      validateAssetUpload({ contentType: "image/png", sizeBytes: ASSET_MAX_BYTES + 1 });
      throw new Error("expected policy failure");
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(413);
    }
  });

  it("passes downloads to Fastify as a stream instead of buffering the asset", async () => {
    const routes = new Map<string, (request: any, reply: any) => Promise<unknown>>();
    const app = {
      get: vi.fn((path: string, handler: (request: any, reply: any) => Promise<unknown>) => routes.set(path, handler)),
      post: vi.fn(),
      put: vi.fn(),
    } as unknown as FastifyInstance;
    const body = Readable.from(["asset-content"]);
    const transformToByteArray = vi.fn();
    Object.assign(body, { transformToByteArray });
    const context = {
      database: { query: vi.fn().mockResolvedValue({ rows: [{ id: "asset-1", object_key: "generic/asset-1/file", content_type: "image/png", visibility: "public", category: "generic", size_bytes: 13 }] }) },
      s3: { send: vi.fn().mockResolvedValue({ Body: body }) },
      redis: {},
      stripe: {},
      sockets: new Set(),
    } as any;
    await registerAssets(app, context);

    const reply = {
      type: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    await routes.get("/assets/:asset_id/download")!({ params: { asset_id: "asset-1" }, query: {} }, reply);

    expect(reply.send).toHaveBeenCalledWith(body);
    expect(transformToByteArray).not.toHaveBeenCalled();
  });
});
