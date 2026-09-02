import { randomUUID } from "node:crypto";

import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { config } from "../config.js";
import { asObject, GetObjectCommand, hmac, HttpError, PutObjectCommand, secureEqual } from "../platform.js";
import type { AppContext } from "../types.js";

export const ASSET_MAX_BYTES = 100 * 1024 * 1024;
export const ASSET_ALLOWED_CATEGORIES = ["dtf", "mockup", "informative", "customizer", "support", "evidence", "generic"] as const;
export const ASSET_ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "application/octet-stream"] as const;
const ASSET_FILE_NAME_MAX_LENGTH = 120;
const ASSET_CLEANUP_BATCH_SIZE = 100;
const allowedCategories = new Set<string>(ASSET_ALLOWED_CATEGORIES);
const allowedTypes = new Set<string>(ASSET_ALLOWED_TYPES);

export type AssetUploadPolicy = {
  contentType: string;
  category?: string;
  sizeBytes?: number;
};

type AssetRow = {
  id: string;
  object_key: string;
  content_type: string;
  visibility: "public" | "internal";
  category: string | null;
  size_bytes: number | string;
  declared_size_bytes?: number | string | null;
  upload_status?: "pending" | "uploading" | "failed" | "ready";
  upload_expires_at?: Date | string | null;
};

type ResolvedAsset = {
  asset_id: string;
  visibility: AssetRow["visibility"];
  content_type: string;
  size_bytes: number;
  url: string;
  signed_url: string;
  public_url: string | null;
};

type SignedUpload = {
  asset_id: string;
  upload_url: string;
  expires_at_unix: number;
  method: "PUT";
};

export type AssetCleanupResult = {
  deletedAssets: number;
  deletedObjects: number;
};

/** Shared upload policy used by signing and storage boundaries. */
export function validateAssetUpload(policy: AssetUploadPolicy): { contentType: string; category: string } {
  const contentType = policy.contentType.split(";", 1)[0]!.trim().toLowerCase();
  const category = (policy.category ?? "generic").trim().toLowerCase();
  if (!allowedTypes.has(contentType)) throw new HttpError(400, "Tipo de archivo no permitido", { allowed_types: ASSET_ALLOWED_TYPES });
  if (!allowedCategories.has(category)) throw new HttpError(400, "Categoría de asset no permitida", { allowed_categories: ASSET_ALLOWED_CATEGORIES });
  if (policy.sizeBytes !== undefined && (!Number.isFinite(policy.sizeBytes) || policy.sizeBytes < 0 || policy.sizeBytes > ASSET_MAX_BYTES)) {
    throw new HttpError(413, "Asset mayor a 100 MB", { max_bytes: ASSET_MAX_BYTES });
  }
  return { contentType, category };
}

function signature(assetId: string, expires: number, mode: string): string {
  return hmac(`${assetId}:${expires}:${mode}`, config.ASSETS_SIGNING_SECRET);
}

function validateSignature(assetId: string, query: Record<string, unknown>, mode: string): void {
  const expires = Number(query.expires ?? 0);
  const sig = String(query.sig ?? "");
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000) || !sig || !secureEqual(sig, signature(assetId, expires, mode))) {
    throw new HttpError(401, "Firma de asset inválida o expirada");
  }
}

function normalizedFileName(value: unknown, fallback: string): string {
  const candidate = String(value ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, ASSET_FILE_NAME_MAX_LENGTH);
  return candidate || fallback;
}

function declaredSize(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const size = Number(value);
  if (!Number.isSafeInteger(size)) throw new HttpError(400, "El tamaño declarado del asset debe ser entero");
  validateAssetUpload({ contentType: "application/octet-stream", sizeBytes: size });
  return size;
}

export function sniffAssetContentType(body: Uint8Array): string {
  if (body.length >= 5 && Buffer.from(body.subarray(0, 5)).toString("ascii") === "%PDF-") return "application/pdf";
  if (body.length >= 8 && Buffer.from(body.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (body.length >= 3 && Buffer.from(body.subarray(0, 3)).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (body.length >= 12 && Buffer.from(body.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(body.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  return "application/octet-stream";
}

function isReady(asset: AssetRow): boolean {
  return asset.upload_status === undefined || asset.upload_status === "ready";
}

async function resolveAsset(context: AppContext, id: string): Promise<ResolvedAsset> {
  const asset = (await context.database.query<AssetRow>("select * from assets where id=$1", [id])).rows[0];
  if (!asset || !isReady(asset)) throw new HttpError(404, "Asset no encontrado");
  const publicUrl = asset.visibility === "public" ? `${config.S3_PUBLIC_ENDPOINT}/assets/${id}/download` : null;
  const expires = Math.floor(Date.now() / 1000) + 900;
  const signedUrl = `${config.S3_PUBLIC_ENDPOINT}/assets/${id}/download?expires=${expires}&sig=${signature(id, expires, "read")}`;
  return { asset_id: id, visibility: asset.visibility, content_type: asset.content_type, size_bytes: Number(asset.size_bytes), url: publicUrl ?? signedUrl, signed_url: signedUrl, public_url: publicUrl };
}

function publicResolution(asset: ResolvedAsset): Omit<ResolvedAsset, "signed_url"> {
  if (asset.visibility !== "public" || !asset.public_url) {
    // Do not disclose that an internal asset exists, nor mint a signed URL for it.
    throw new HttpError(404, "Asset no encontrado");
  }
  return {
    asset_id: asset.asset_id,
    visibility: asset.visibility,
    content_type: asset.content_type,
    size_bytes: asset.size_bytes,
    url: asset.public_url,
    public_url: asset.public_url,
  };
}

async function signUpload(context: AppContext, body: Record<string, unknown>): Promise<SignedUpload> {
  const id = randomUUID();
  const { contentType, category } = validateAssetUpload({
    contentType: String(body.content_type ?? "application/octet-stream"),
    category: String(body.category ?? "generic"),
    sizeBytes: body.size_bytes === undefined ? undefined : Number(body.size_bytes),
  });
  const sizeBytes = declaredSize(body.size_bytes);
  const ttl = Math.min(Math.max(Number(body.ttl_sec ?? 900), 60), 3600);
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const safeName = normalizedFileName(body.file_name, id);
  const objectKey = `${category}/${id}/${safeName}`;
  await context.database.query(`insert into assets(id,object_key,file_name,content_type,visibility,category,declared_size_bytes,upload_status,upload_expires_at)
    values($1,$2,$3,$4,$5,$6,$7,'pending',to_timestamp($8))`, [id, objectKey, safeName, contentType, body.visibility === "public" ? "public" : "internal", category, sizeBytes, expires]);
  return { asset_id: id, upload_url: `${config.API_PUBLIC_ENDPOINT.replace(/\/$/, "")}/assets/${id}/upload?expires=${expires}&sig=${signature(id, expires, "upload")}`, expires_at_unix: expires, method: "PUT" };
}

function isExpired(value: Date | string | null | undefined): boolean {
  return !value || new Date(value).getTime() <= Date.now();
}

async function deleteObject(context: AppContext, key: string): Promise<void> {
  await context.s3.send(new DeleteObjectsCommand({
    Bucket: config.S3_BUCKET,
    Delete: { Objects: [{ Key: key }], Quiet: true },
  }));
}

async function deleteObjectBatch(context: AppContext, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  await context.s3.send(new DeleteObjectsCommand({
    Bucket: config.S3_BUCKET,
    Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
  }));
  return keys.length;
}

/** Removes expired upload reservations and old S3 objects with no database owner. */
export async function cleanupOrphanedAssets(
  context: AppContext,
  graceSeconds = config.ASSET_ORPHAN_GRACE_SEC,
  batchSize = ASSET_CLEANUP_BATCH_SIZE,
): Promise<AssetCleanupResult> {
  const stale = (await context.database.query<{ id: string; object_key: string }>(`
    select id, object_key from assets
    where (upload_status = 'pending' and upload_expires_at < now())
       or (upload_status in ('uploading', 'failed') and updated_at < now() - ($1 * interval '1 second'))
    order by updated_at
    limit $2
  `, [graceSeconds, batchSize])).rows;
  let deletedAssets = 0;
  for (const asset of stale) {
    try {
      await deleteObject(context, asset.object_key);
      const deleted = await context.database.query(
        "delete from assets where id=$1 and upload_status in ('pending','uploading','failed')",
        [asset.id],
      );
      deletedAssets += deleted.rowCount ?? 0;
    } catch {
      // Keep the row so a transient storage/database failure is retried later.
    }
  }

  const knownKeys = new Set((await context.database.query<{ object_key: string }>("select object_key from assets")).rows.map((row) => row.object_key));
  const cutoff = Date.now() - graceSeconds * 1000;
  let continuationToken: string | undefined;
  let deletedObjects = 0;
  do {
    const listed = await context.s3.send(new ListObjectsV2Command({ Bucket: config.S3_BUCKET, ContinuationToken: continuationToken }));
    const orphanKeys = (listed.Contents ?? [])
      .filter((object) => object.Key && !knownKeys.has(object.Key) && object.LastModified && object.LastModified.getTime() <= cutoff)
      .map((object) => object.Key!);
    for (let index = 0; index < orphanKeys.length; index += 1000) {
      deletedObjects += await deleteObjectBatch(context, orphanKeys.slice(index, index + 1000));
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return { deletedAssets, deletedObjects };
}

export async function registerAssets(app: FastifyInstance, context: AppContext): Promise<void> {
  app.post("/admin/assets/sign-upload", async (request, reply) => { const result = await signUpload(context, asObject(request.body)); reply.status(201); return result; });
  app.post("/assets/sign-upload", async (request, reply) => {
    if (request.headers["x-internal-api-key"] !== config.ASSETS_INTERNAL_API_KEY) throw new HttpError(401, "API key de assets inválida");
    const result = await signUpload(context, asObject(request.body)); reply.status(201); return result;
  });
  const signRead = async (request: FastifyRequest<{ Params: { asset_id: string } }>) => {
    const asset = await resolveAsset(context, request.params.asset_id);
    const ttl = Math.min(Math.max(Number(asObject(request.body).ttl_sec ?? 900), 60), 3600);
    const expires = Math.floor(Date.now() / 1000) + ttl;
    return { asset_id: request.params.asset_id, url: `${config.S3_PUBLIC_ENDPOINT}/assets/${request.params.asset_id}/download?expires=${expires}&sig=${signature(request.params.asset_id, expires, "read")}`, expires_at_unix: expires, visibility: asset.visibility };
  };
  app.post("/admin/assets/:asset_id/sign-read", signRead);
  app.post<{ Params: { asset_id: string } }>("/assets/:asset_id/sign-read", async (request) => {
    if (request.headers["x-internal-api-key"] !== config.ASSETS_INTERNAL_API_KEY) throw new HttpError(401, "API key de assets inválida");
    return signRead(request);
  });
  app.get<{ Params: { asset_id: string } }>("/assets/:asset_id/resolve", async (request) => publicResolution(await resolveAsset(context, request.params.asset_id)));
  app.get<{ Params: { asset_id: string } }>("/admin/assets/:asset_id/resolve", async (request) => resolveAsset(context, request.params.asset_id));
  app.put<{ Params: { asset_id: string } }>("/assets/:asset_id/upload", { bodyLimit: ASSET_MAX_BYTES }, async (request, reply) => {
    validateSignature(request.params.asset_id, asObject(request.query), "upload");
    const asset = (await context.database.query<AssetRow>(`update assets
      set upload_status='uploading', upload_started_at=now(), updated_at=now()
      where id=$1 and upload_status='pending' and upload_expires_at > now()
      returning *`, [request.params.asset_id])).rows[0];
    if (!asset) {
      const existing = (await context.database.query<AssetRow>("select upload_status,upload_expires_at from assets where id=$1", [request.params.asset_id])).rows[0];
      if (!existing) throw new HttpError(404, "Asset no encontrado");
      if (existing.upload_status === "ready") throw new HttpError(409, "El asset ya fue subido");
      if (existing.upload_status === "pending" && isExpired(existing.upload_expires_at)) throw new HttpError(410, "La subida del asset expiró");
      throw new HttpError(409, "La subida del asset ya está en proceso");
    }
    const body = Buffer.isBuffer(request.body)
      ? request.body
      : typeof request.body === "string" || request.body instanceof Uint8Array
        ? Buffer.from(request.body)
        : null;
    if (!body) throw new HttpError(400, "Contenido de asset inválido");
    const contentType = String(request.headers["content-type"] ?? asset.content_type).split(";", 1)[0]!.toLowerCase();
    validateAssetUpload({ contentType, category: String(asset.category ?? "generic"), sizeBytes: body.byteLength });
    if (contentType !== asset.content_type) {
      await context.database.query("update assets set upload_status='failed',updated_at=now() where id=$1 and upload_status='uploading'", [asset.id]);
      throw new HttpError(400, "El tipo de contenido no coincide con la firma");
    }
    if (asset.declared_size_bytes !== null && asset.declared_size_bytes !== undefined && Number(asset.declared_size_bytes) !== body.byteLength) {
      await context.database.query("update assets set upload_status='failed',updated_at=now() where id=$1 and upload_status='uploading'", [asset.id]);
      throw new HttpError(400, "El tamaño no coincide con la firma del asset");
    }
    const detectedType = sniffAssetContentType(body);
    if (contentType !== "application/octet-stream" && detectedType !== contentType) {
      await context.database.query("update assets set upload_status='failed',updated_at=now() where id=$1 and upload_status='uploading'", [asset.id]);
      throw new HttpError(400, "El contenido no coincide con el tipo de archivo");
    }
    let result: { ETag?: string };
    try {
      result = await context.s3.send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: asset.object_key, Body: body, ContentType: contentType }));
    } catch (error) {
      await context.database.query("update assets set upload_status='failed',updated_at=now() where id=$1 and upload_status='uploading'", [asset.id]).catch(() => undefined);
      throw error;
    }
    await context.database.query("update assets set content_type=$2,size_bytes=$3,etag=$4,upload_status='ready',uploaded_at=now(),updated_at=now() where id=$1 and upload_status='uploading'", [asset.id, contentType, body.byteLength, result.ETag ?? null]);
    reply.status(204).send();
  });
  app.get<{ Params: { asset_id: string } }>("/assets/:asset_id/download", async (request, reply) => {
    const asset = (await context.database.query<AssetRow>("select * from assets where id=$1", [request.params.asset_id])).rows[0];
    if (!asset || !isReady(asset)) throw new HttpError(404, "Asset no encontrado");
    if (asset.visibility !== "public") validateSignature(request.params.asset_id, asObject(request.query), "read");
    const object = await context.s3.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: asset.object_key }));
    if (!object.Body) throw new HttpError(404, "Contenido del asset no encontrado");
    reply.type(asset.content_type).header("content-length", String(asset.size_bytes)).header("content-disposition", asset.content_type === "application/octet-stream" ? "attachment" : "inline").header("cache-control", asset.visibility === "public" ? "public, max-age=31536000, immutable" : "private, no-store");
    return reply.send(object.Body);
  });
}
