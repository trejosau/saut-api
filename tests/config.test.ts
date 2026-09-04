import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";

const productionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://saut:production-password@db.internal:5432/saut",
  POSTGRES_ADMIN_URL: "postgres://saut:production-password@db.internal:5432/postgres",
  REDIS_URL: "redis://:production-password@redis.internal:6379/0",
  AUTH_CODE_SECRET: "production-code-secret",
  AUTH_TOKEN_SECRET: "production-token-secret",
  AUTH_INTERNAL_API_KEY: "production-internal-key",
  S3_SECRET_KEY: "production-s3-secret",
  ASSETS_SIGNING_SECRET: "production-signing-secret",
  ASSETS_INTERNAL_API_KEY: "production-assets-key",
  STRIPE_SECRET_KEY: "sk_live_production-key",
  STRIPE_WEBHOOK_SECRET: "whsec_production-secret",
  SKYDROPX_WEBHOOK_SECRET: "skydropx_production-secret",
  AUTH_DEV_RETURN_CODE: "false",
  NOTIFICATION_DEV_MODE: "false",
  MIGRATION_DROP_LEGACY_DATABASES: "false",
  RATE_LIMIT_FAIL_OPEN: "false",
  STRIPE_MODE: "live",
  SKYDROPX_MODE: "live",
  WEBAUTHN_RP_ID: "saut.example.com",
  WEBAUTHN_EXPECTED_ORIGIN: "https://saut.example.com",
} satisfies NodeJS.ProcessEnv;

describe("parseConfig", () => {
  it("keeps development defaults available outside production", () => {
    expect(parseConfig({ NODE_ENV: "test" }).AUTH_DEV_RETURN_CODE).toBe(true);
  });

  it("accepts explicit production-safe values", () => {
    expect(parseConfig(productionEnvironment).NODE_ENV).toBe("production");
  });

  it("rejects development defaults in production", () => {
    expect(() => parseConfig({ NODE_ENV: "production" })).toThrowError();
  });

  it("rejects fail-open rate limiting in production", () => {
    expect(() => parseConfig({ ...productionEnvironment, RATE_LIMIT_FAIL_OPEN: "true" })).toThrowError();
  });

  it("rejects mock provider credentials in production", () => {
    expect(() => parseConfig({ ...productionEnvironment, STRIPE_SECRET_KEY: "sk_test_mock" })).toThrowError();
    expect(() => parseConfig({ ...productionEnvironment, SKYDROPX_WEBHOOK_SECRET: "skydropx_wh_mock" })).toThrowError();
  });

  it("requires a production WebAuthn relying-party domain and HTTPS origin", () => {
    expect(() => parseConfig({ ...productionEnvironment, WEBAUTHN_RP_ID: "localhost" })).toThrowError();
    expect(() => parseConfig({ ...productionEnvironment, WEBAUTHN_EXPECTED_ORIGIN: "http://saut.example.com" })).toThrowError();
  });

  it("rejects empty and example placeholder auth secrets in production", () => {
    expect(() => parseConfig({ ...productionEnvironment, AUTH_INTERNAL_API_KEY: "" })).toThrowError();
    expect(() => parseConfig({ ...productionEnvironment, AUTH_TOKEN_SECRET: "CHANGE_ME_AUTH_TOKEN_SECRET" })).toThrowError();
  });

  it("defaults to not trusting forwarded proxy headers", () => {
    expect(parseConfig({ NODE_ENV: "test" }).TRUST_PROXY_HOPS).toBe(0);
    expect(parseConfig({ ...productionEnvironment, TRUST_PROXY_HOPS: "1" }).TRUST_PROXY_HOPS).toBe(1);
    expect(() => parseConfig({ ...productionEnvironment, TRUST_PROXY_HOPS: "11" })).toThrowError();
  });
});
