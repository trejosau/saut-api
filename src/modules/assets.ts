import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { config } from "../config.js";
import { asObject, GetObjectCommand, hmac, HttpError, PutObjectCommand, secureEqual } from "../platform.js";
import type { AppContext } from "../types.js";

export const ASSET_MAX_BYTES = 100 * 1024 * 1024;
export const ASSET_ALLOWED_CATEGORIES = ["dtf", "mockup", "informative", "customizer", "support", "evidence", "generic"] as const;
export const ASSET_ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "application/octet-stream"] as const;
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
  if (!expires || expires < Math.floor(Date.now() / 1000) || !sig || !secureEqual(sig, signature(assetId, expires, mode))) {
    throw new HttpError(401, "Firma de asset inválida o expirada");
  }
}

async function resolveAsset(context: AppContext, id: string): Promise<ResolvedAsset> {
  const asset = (await context.database.query<AssetRow>("select * from assets where id=$1", [id])).rows[0];
  if (!asset) throw new HttpError(404, "Asset no encontrado");
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

async function signUpload(context: AppContext, body: Record<string, unknown>, requestBaseUrl: string): Promise<SignedUpload> {
  const { contentType, category } = validateAssetUpload({
    contentType: String(body.content_type ?? "application/octet-stream"),
    category: String(body.category ?? "generic"),
    sizeBytes: body.size_bytes === undefined ? undefined : Number(body.size_bytes),
  });
  const id = randomUUID();
  const safeName = String(body.file_name ?? id).replace(/[^a-zA-Z0-9._-]/g, "_");
  const objectKey = `${category}/${id}/${safeName}`;
  await context.database.query(`insert into assets(id,object_key,file_name,content_type,visibility,category)
    values($1,$2,$3,$4,$5,$6)`, [id, objectKey, body.file_name ?? null, contentType, body.visibility === "public" ? "public" : "internal", category]);
  const ttl = Math.min(Math.max(Number(body.ttl_sec ?? 900), 60), 3600);
  const expires = Math.floor(Date.now() / 1000) + ttl;
  return { asset_id: id, upload_url: `${requestBaseUrl}/assets/${id}/upload?expires=${expires}&sig=${signature(id, expires, "upload")}`, expires_at_unix: expires, method: "PUT" };
}

export async function registerAssets(app: FastifyInstance, context: AppContext): Promise<void> {
  app.post("/admin/assets/sign-upload", async (request, reply) => { const result = await signUpload(context, asObject(request.body), `${request.protocol}://${request.headers.host}`); reply.status(201); return result; });
  app.post("/assets/sign-upload", async (request, reply) => {
    if (request.headers["x-internal-api-key"] !== config.ASSETS_INTERNAL_API_KEY) throw new HttpError(401, "API key de assets inválida");
    const result = await signUpload(context, asObject(request.body), `${request.protocol}://${request.headers.host}`); reply.status(201); return result;
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
  app.put<{ Params: { asset_id: string } }>("/assets/:asset_id/upload", async (request, reply) => {
    validateSignature(request.params.asset_id, asObject(request.query), "upload");
    const asset = (await context.database.query<AssetRow>("select * from assets where id=$1", [request.params.asset_id])).rows[0];
    if (!asset) throw new HttpError(404, "Asset no encontrado");
    const body = Buffer.isBuffer(request.body)
      ? request.body
      : typeof request.body === "string" || request.body instanceof Uint8Array
        ? Buffer.from(request.body)
        : null;
    if (!body) throw new HttpError(400, "Contenido de asset inválido");
    const contentType = String(request.headers["content-type"] ?? asset.content_type).split(";", 1)[0]!.toLowerCase();
    validateAssetUpload({ contentType, category: String(asset.category ?? "generic"), sizeBytes: body.byteLength });
    const result = await context.s3.send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: asset.object_key, Body: body, ContentType: contentType }));
    await context.database.query("update assets set content_type=$2,size_bytes=$3,etag=$4,updated_at=now() where id=$1", [asset.id, contentType, body.byteLength, result.ETag ?? null]);
    reply.status(204).send();
  });
  app.get<{ Params: { asset_id: string } }>("/assets/:asset_id/download", async (request, reply) => {
    const asset = (await context.database.query<AssetRow>("select * from assets where id=$1", [request.params.asset_id])).rows[0];
    if (!asset) throw new HttpError(404, "Asset no encontrado");
    if (asset.visibility !== "public") validateSignature(request.params.asset_id, asObject(request.query), "read");
    const object = await context.s3.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: asset.object_key }));
    if (!object.Body) throw new HttpError(404, "Contenido del asset no encontrado");
    reply.type(asset.content_type).header("content-length", String(asset.size_bytes)).header("cache-control", asset.visibility === "public" ? "public, max-age=31536000, immutable" : "private, no-store");
    return reply.send(object.Body);
  });
}
