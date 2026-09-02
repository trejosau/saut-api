import { describe, expect, it } from "vitest";

import { ASSET_MAX_BYTES, validateAssetUpload } from "../src/modules/assets.js";

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
});
