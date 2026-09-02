import "dotenv/config";

import { z } from "zod";

// Centralized runtime configuration.
const booleanValue = z.preprocess(
  (value) => value === undefined
    ? undefined
    : ["1", "true", "yes", "on"].includes(String(value).toLowerCase()),
  z.boolean().optional()
);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().default("postgres://saut:saut@localhost:5432/saut"),
  POSTGRES_ADMIN_URL: z.string().default("postgres://saut:saut@localhost:5432/postgres"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:4200"),
  AUTH_CODE_SECRET: z.string().default("dev-auth-code-secret"),
  AUTH_TOKEN_SECRET: z.string().default("dev-auth-token-secret-change-me"),
  AUTH_INTERNAL_API_KEY: z.string().default("dev-internal-auth-key"),
  AUTH_CODE_TTL_SEC: z.coerce.number().int().positive().default(600),
  AUTH_CODE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  AUTH_CODE_MIN_RESEND_SEC: z.coerce.number().int().nonnegative().default(30),
  AUTH_SESSION_TTL_SEC: z.coerce.number().int().positive().default(2592000),
  AUTH_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
  ANALYTICS_WS_TICKET_TTL_SEC: z.coerce.number().int().positive().default(60),
  AUTH_DEV_RETURN_CODE: booleanValue.default(true),
  AUTH_AUTO_CREATE: booleanValue.default(true),
  AUTH_ADMIN_EMAILS: z.string().default("albertosaut@gmail.com"),
  AUTH_DEFAULT_CUSTOMER_ROLE: z.string().default("customer"),
  AUTH_MAGIC_LINK_BASE_URL: z.url().default("http://localhost:4200/auth/verify"),
  AUTH_GOOGLE_CLIENT_ID: z.string().default(""),
  AUTH_GOOGLE_CLIENT_SECRET: z.string().default(""),
  AUTH_GOOGLE_DISCOVERY_URL: z.url().default("https://accounts.google.com/.well-known/openid-configuration"),
  AUTH_GOOGLE_REDIRECT_URI: z.url().default("http://localhost:8080/api/auth/google/callback"),
  AUTH_GOOGLE_FRONTEND_BASE_URL: z.url().default("http://localhost:4200"),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_GLOBAL_WINDOW_SEC: z.coerce.number().int().positive().default(1),
  RATE_LIMIT_FAIL_OPEN: booleanValue.default(true),
  REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  PAGINATION_MAX: z.coerce.number().int().positive().default(200),
  EXTERNAL_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  S3_ENDPOINT: z.url().default("http://localhost:9000"),
  S3_PUBLIC_ENDPOINT: z.url().default("http://localhost:8080"),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("saut-assets"),
  S3_ACCESS_KEY: z.string().default("saut_minio"),
  S3_SECRET_KEY: z.string().default("saut_minio_password"),
  ASSETS_SIGNING_SECRET: z.string().default("dev-assets-signing-secret"),
  ASSETS_INTERNAL_API_KEY: z.string().default("dev-assets-internal-key"),
  STRIPE_MODE: z.enum(["mock", "live"]).default("mock"),
  STRIPE_SECRET_KEY: z.string().default("sk_test_mock"),
  STRIPE_WEBHOOK_SECRET: z.string().default("whsec_mock"),
  SKYDROPX_MODE: z.enum(["mock", "live"]).default("mock"),
  SKYDROPX_BASE_URL: z.url().default("https://pro.skydropx.com"),
  SKYDROPX_CLIENT_ID: z.string().default(""),
  SKYDROPX_CLIENT_SECRET: z.string().default(""),
  SKYDROPX_GRANT_TYPE: z.string().default("client_credentials"),
  SKYDROPX_SCOPE: z.string().default(""),
  SKYDROPX_REQUESTED_CARRIERS: z.string().default(""),
  SKYDROPX_WEBHOOK_SECRET: z.string().default("skydropx_wh_mock"),
  SHIP_FROM_COUNTRY_CODE: z.string().default("MX"),
  SHIP_FROM_POSTAL_CODE: z.string().default("27000"),
  SHIP_FROM_AREA_LEVEL1: z.string().default("Coahuila"),
  SHIP_FROM_AREA_LEVEL2: z.string().default("Torreon"),
  SHIP_FROM_AREA_LEVEL3: z.string().default("Torreon"),
  SHIP_FROM_STREET1: z.string().default("Pendiente 123"),
  SHIP_FROM_NAME: z.string().default("Operacion SAUT"),
  SHIP_FROM_PHONE: z.string().default("8710000000"),
  SHIP_FROM_EMAIL: z.string().default("ops@saut.dev"),
  DEFAULT_PARCEL_WEIGHT_KG: z.coerce.number().positive().default(0.45),
  DEFAULT_PARCEL_LENGTH_CM: z.coerce.number().positive().default(35),
  DEFAULT_PARCEL_WIDTH_CM: z.coerce.number().positive().default(28),
  DEFAULT_PARCEL_HEIGHT_CM: z.coerce.number().positive().default(4),
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_FROM_EMAIL: z.string().optional(),
  TWILIO_API_KEY: z.string().optional(),
  TWILIO_FROM_EMAIL: z.string().optional(),
  NOTIFICATION_DEV_MODE: booleanValue.default(true),
  LOCAL_SHIPPING_COST_MXN: z.coerce.number().int().nonnegative().default(79),
  NATIONAL_SHIPPING_COST_MXN: z.coerce.number().int().nonnegative().default(149),
  PRICING_DEFAULT_CUSTOMIZER_BASE_PRICE_MXN: z.coerce.number().int().nonnegative().default(499),
  PRICING_DEFAULT_CUSTOMIZER_PER_IMAGE_PRICE_MXN: z.coerce.number().int().nonnegative().default(50),
  MIGRATION_BACKUP_DIR: z.string().default("./backups"),
  MIGRATION_IMPORT_LEGACY_DATABASES: booleanValue.default(false),
  MIGRATION_DROP_LEGACY_DATABASES: booleanValue.default(false)
}).superRefine((values, context) => {
  if (values.NODE_ENV !== "production") return;

  const unsafeSecrets: Array<[keyof typeof values, string]> = [
    ["AUTH_CODE_SECRET", "dev-auth-code-secret"],
    ["AUTH_TOKEN_SECRET", "dev-auth-token-secret-change-me"],
    ["AUTH_INTERNAL_API_KEY", "dev-internal-auth-key"],
    ["S3_SECRET_KEY", "saut_minio_password"],
    ["ASSETS_SIGNING_SECRET", "dev-assets-signing-secret"],
    ["ASSETS_INTERNAL_API_KEY", "dev-assets-internal-key"]
  ];

  for (const [path, developmentValue] of unsafeSecrets) {
    if (values[path] === developmentValue) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message: "must be configured with a non-development value in production"
      });
    }
  }

  const unsafeFlags: Array<keyof typeof values> = [
    "AUTH_DEV_RETURN_CODE",
    "NOTIFICATION_DEV_MODE",
    "MIGRATION_DROP_LEGACY_DATABASES",
    "RATE_LIMIT_FAIL_OPEN"
  ];
  for (const path of unsafeFlags) {
    if (values[path] === true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message: "must be disabled in production"
      });
    }
  }

  if (values.STRIPE_MODE === "mock") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["STRIPE_MODE"], message: "must be live in production" });
  }
  if (values.SKYDROPX_MODE === "mock") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["SKYDROPX_MODE"], message: "must be live in production" });
  }
  if (values.CORS_ALLOWED_ORIGINS.split(",").some((origin) => origin.trim() === "*")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["CORS_ALLOWED_ORIGINS"], message: "must not use wildcard origins in production" });
  }
});

export function parseConfig(environment: NodeJS.ProcessEnv): z.infer<typeof schema> {
  return schema.parse(environment);
}

const parsed = parseConfig(process.env);

export const config = {
  ...parsed,
  corsOrigins: parsed.CORS_ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
  adminEmails: new Set(parsed.AUTH_ADMIN_EMAILS.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)),
  sendgridApiKey: parsed.SENDGRID_API_KEY ?? parsed.TWILIO_API_KEY ?? "",
  sendgridFromEmail: parsed.SENDGRID_FROM_EMAIL ?? parsed.TWILIO_FROM_EMAIL ?? "no-reply@saut.dev"
};

export type Config = typeof config;
