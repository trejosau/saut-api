import { describe, expect, it } from "vitest";

import { isSupportedGarmentType, requireSupportedGarmentType } from "../src/modules/garment-types.js";

describe("supported garment types", () => {
  it("accepts the two active product families", () => {
    expect(isSupportedGarmentType("tshirt")).toBe(true);
    expect(isSupportedGarmentType("hoodie")).toBe(true);
  });

  it("rejects any retired product family", () => {
    expect(isSupportedGarmentType("unsupported")).toBe(false);
    expect(() => requireSupportedGarmentType("unsupported")).toThrow("Tipo de prenda no soportado");
  });
});
