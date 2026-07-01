import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import {
  createNationalShipment,
  fetchTracking,
  quoteNational,
  ratesFrom,
} from "../src/providers/skydropx.js";

const originalMode = config.SKYDROPX_MODE;
const originalClientId = config.SKYDROPX_CLIENT_ID;
const originalClientSecret = config.SKYDROPX_CLIENT_SECRET;

describe("Skydropx provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    config.SKYDROPX_MODE = "mock";
  });

  afterEach(() => {
    config.SKYDROPX_MODE = originalMode;
    config.SKYDROPX_CLIENT_ID = originalClientId;
    config.SKYDROPX_CLIENT_SECRET = originalClientSecret;
    vi.unstubAllGlobals();
  });

  it("returns deterministic local-safe mock responses", async () => {
    await expect(quoteNational({ postal_code: "27000" })).resolves.toEqual([
      expect.objectContaining({ quote_id: "national-standard", price_mxn: config.NATIONAL_SHIPPING_COST_MXN }),
    ]);
    await expect(createNationalShipment({ total_mxn: 900 }, "rate-1", {})).resolves.toEqual(
      expect.objectContaining({ tracking_carrier: "Skydropx", raw: { mode: "mock" } })
    );
    await expect(fetchTracking("SAUT01", "Skydropx")).resolves.toEqual(
      expect.objectContaining({ delivered: false, raw: { mode: "mock" } })
    );
  });

  it("normalizes nested provider rates and rejects malformed entries", () => {
    expect(ratesFrom({ data: { attributes: { rates: [
      { id: "rate-1", carrier_name: "DHL", amount: "125.4", days: 2 },
      { amount: 50 },
      { id: "bad", amount: "not-a-number" },
    ] } } }, "quote-1")).toEqual([
      {
        quote_id: "rate-1",
        provider: "DHL",
        service: "standard",
        price_mxn: 125,
        eta_days: 2,
        quotation_id: "quote-1",
      },
    ]);
  });

  it("authenticates and maps a live quotation", async () => {
    config.SKYDROPX_MODE = "live";
    config.SKYDROPX_CLIENT_ID = "client-id";
    config.SKYDROPX_CLIENT_SECRET = "client-secret";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "quotation-1",
        rates: [{ id: "rate-1", provider_name: "Estafeta", total: 149, days: 3 }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(quoteNational({ postal_code: "01000", state: "CDMX", city: "CDMX" }, "order-1"))
      .resolves.toEqual([expect.objectContaining({ quote_id: "rate-1", quotation_id: "quotation-1" })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces credential and empty-rate failures without leaking internals", async () => {
    config.SKYDROPX_MODE = "live";
    config.SKYDROPX_CLIENT_ID = "";
    config.SKYDROPX_CLIENT_SECRET = "";
    await expect(quoteNational({})).rejects.toMatchObject({ statusCode: 503 });

    config.SKYDROPX_CLIENT_ID = "client-id";
    config.SKYDROPX_CLIENT_SECRET = "client-secret";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })));
    await expect(quoteNational({})).rejects.toThrow("Skydropx no devolvió tarifas");
  });

  it("maps live shipment and delivered tracking payloads", async () => {
    config.SKYDROPX_MODE = "live";
    config.SKYDROPX_CLIENT_ID = "client-id";
    config.SKYDROPX_CLIENT_SECRET = "client-secret";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          id: "shipment-1",
          attributes: {
            tracking_number: "TRACK-1",
            carrier_name: "DHL",
            tracking_url_provider: "https://tracking.example/1",
            label_url: "https://labels.example/1.pdf",
          },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ attributes: { status: "delivered", description: "Entregado" } }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createNationalShipment({
      address: { line1: "Calle 1", postal_code: "01000", state: "CDMX", city: "CDMX" },
      customer_email: "buyer@example.com",
      customer_phone: "5555555555",
      total_mxn: 900,
    }, "rate-1", {})).resolves.toEqual(expect.objectContaining({
      provider_shipment_id: "shipment-1",
      tracking_number: "TRACK-1",
      tracking_carrier: "DHL",
    }));
    await expect(fetchTracking("TRACK-1", "DHL")).resolves.toEqual(
      expect.objectContaining({ delivered: true })
    );
  });
});
