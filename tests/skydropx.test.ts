import { describe, expect, it } from "vitest";

import { ratesFrom } from "../src/providers/skydropx.js";

describe("Skydropx provider mapping", () => {
  it("maps the supported response shapes to the public quote contract", () => {
    expect(ratesFrom({ data: { attributes: { rates: [
      { id: "rate-1", provider_name: "DHL", provider_service_name: "Express", total: "149.90", days: 2 },
    ] } } }, "quotation-1")).toEqual([{
      quote_id: "rate-1",
      provider: "DHL",
      service: "Express",
      price_mxn: 150,
      eta_days: 2,
      quotation_id: "quotation-1",
    }]);
  });

  it("drops malformed or negative rates instead of leaking unusable options", () => {
    expect(ratesFrom({ rates: [
      { id: "", total: 10 },
      { id: "negative", total: -1 },
      { id: "valid", total: 0, days: 0 },
    ] })).toEqual([{
      quote_id: "valid",
      provider: "skydropx",
      service: "standard",
      price_mxn: 0,
      eta_days: 1,
    }]);
  });
});
