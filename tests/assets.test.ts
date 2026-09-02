import { Readable } from "node:stream";

import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { ASSET_MAX_BYTES, cleanupOrphanedAssets, registerAssets, sniffAssetContentType, validateAssetUpload } from "../src/modules/assets.js";
import { hmac } from "../src/platform.js";

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

  it("detects file signatures instead of trusting a declared MIME type", () => {
    expect(sniffAssetContentType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffAssetContentType(Buffer.from("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffAssetContentType(Buffer.from("not an image"))).toBe("application/octet-stream");
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

  it("claims an upload once and marks it ready only after storage succeeds", async () => {
    const routes = new Map<string, (request: any, reply: any) => Promise<unknown>>();
    const app = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn((path: string, options: unknown, handler?: (request: any, reply: any) => Promise<unknown>) => routes.set(path, handler ?? options as (request: any, reply: any) => Promise<unknown>)),
    } as unknown as FastifyInstance;
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const asset = { id: "asset-1", object_key: "support/asset-1/file.png", content_type: "image/png", visibility: "internal", category: "support", size_bytes: 0, declared_size_bytes: body.length, upload_status: "pending", upload_expires_at: new Date(Date.now() + 60_000) };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [asset], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const context = { database: { query }, s3: { send: vi.fn().mockResolvedValue({ ETag: '"etag"' }) }, redis: {}, stripe: {}, sockets: new Set() } as any;
    await registerAssets(app, context);
    const reply = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
    const expires = Math.floor(Date.now() / 1000) + 60;
    await routes.get("/assets/:asset_id/upload")!({
      params: { asset_id: asset.id },
      query: { expires, sig: hmac(`${asset.id}:${expires}:upload`, config.ASSETS_SIGNING_SECRET) },
      headers: { "content-type": "image/png" },
      body,
    }, reply);

    expect(context.s3.send).toHaveBeenCalledOnce();
    expect(context.s3.send.mock.calls[0]![0].input.ContentType).toBe("image/png");
    expect(query.mock.calls[0]![0]).toContain("upload_status='uploading'");
    expect(query.mock.calls[1]![0]).toContain("upload_status='ready'");
  });

  it("rejects a second concurrent upload while the first owns the reservation", async () => {
    const routes = new Map<string, (request: any, reply: any) => Promise<unknown>>();
    const app = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn((path: string, options: unknown, handler?: (request: any, reply: any) => Promise<unknown>) => routes.set(path, handler ?? options as (request: any, reply: any) => Promise<unknown>)),
    } as unknown as FastifyInstance;
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const asset = { id: "asset-2", object_key: "support/asset-2/file.png", content_type: "image/png", visibility: "internal", category: "support", size_bytes: 0, declared_size_bytes: body.length, upload_status: "pending", upload_expires_at: new Date(Date.now() + 60_000) };
    let releaseStorage!: (value: { ETag: string }) => void;
    const storage = new Promise<{ ETag: string }>((resolve) => { releaseStorage = resolve; });
    let claimCount = 0;
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("set upload_status='uploading'")) {
        claimCount += 1;
        return claimCount === 1 ? { rows: [asset], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes("select upload_status,upload_expires_at")) return { rows: [{ upload_status: "uploading", upload_expires_at: asset.upload_expires_at }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const context = { database: { query }, s3: { send: vi.fn().mockReturnValue(storage) }, redis: {}, stripe: {}, sockets: new Set() } as any;
    await registerAssets(app, context);
    const request = { params: { asset_id: asset.id }, query: { expires: Math.floor(Date.now() / 1000) + 60, sig: "" }, headers: { "content-type": "image/png" }, body };
    request.query.sig = hmac(`${asset.id}:${request.query.expires}:upload`, config.ASSETS_SIGNING_SECRET);
    const first = routes.get("/assets/:asset_id/upload")!(request, { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() });
    await new Promise((resolve) => setImmediate(resolve));
    await expect(routes.get("/assets/:asset_id/upload")!(request, { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() })).rejects.toMatchObject({ statusCode: 409 });
    releaseStorage({ ETag: '"etag"' });
    await first;
    expect(claimCount).toBe(2);
  });

  it("removes expired reservations and old unowned storage objects", async () => {
    const old = new Date(Date.now() - 90_000);
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "stale", object_key: "support/stale/file.png" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ object_key: "support/kept/file.png" }], rowCount: 1 });
    const send = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Contents: [{ Key: "support/kept/file.png", LastModified: old }, { Key: "orphan/file.png", LastModified: old }], IsTruncated: false })
      .mockResolvedValueOnce({});
    const result = await cleanupOrphanedAssets({ database: { query }, s3: { send }, redis: {}, stripe: {}, sockets: new Set() } as any, 60, 10);

    expect(result).toEqual({ deletedAssets: 1, deletedObjects: 1 });
    expect(send.mock.calls[0]![0].input.Delete.Objects).toEqual([{ Key: "support/stale/file.png" }]);
    expect(send.mock.calls[2]![0].input.Delete.Objects).toEqual([{ Key: "orphan/file.png" }]);
  });
});
