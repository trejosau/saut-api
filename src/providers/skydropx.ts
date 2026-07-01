import { randomUUID } from "node:crypto";

import { config } from "../config.js";
import { asObject, HttpError } from "../platform.js";

export type ShippingQuote = {
  quote_id: string;
  provider: string;
  service: string;
  price_mxn: number;
  eta_days: number;
  quotation_id?: string;
};

async function accessToken(): Promise<string> {
  if (!config.SKYDROPX_CLIENT_ID || !config.SKYDROPX_CLIENT_SECRET) throw new HttpError(503, "Credenciales Skydropx no configuradas");
  const form = new URLSearchParams({ client_id: config.SKYDROPX_CLIENT_ID, client_secret: config.SKYDROPX_CLIENT_SECRET, grant_type: config.SKYDROPX_GRANT_TYPE });
  if (config.SKYDROPX_SCOPE) form.set("scope", config.SKYDROPX_SCOPE);
  const response = await fetch(`${config.SKYDROPX_BASE_URL}/api/v1/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  if (!response.ok) throw new HttpError(503, `Skydropx OAuth falló (${response.status})`);
  const token = String(asObject(await response.json()).access_token ?? "");
  if (!token) throw new HttpError(503, "Skydropx no devolvió access_token");
  return token;
}

function findDeep(value: unknown, key: string): any {
  if (Array.isArray(value)) for (const item of value) { const found = findDeep(item, key); if (found !== undefined) return found; }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record[key] !== undefined) return record[key];
    for (const item of Object.values(record)) { const found = findDeep(item, key); if (found !== undefined) return found; }
  }
  return undefined;
}

function ratesFrom(payload: any, quotationId?: string): ShippingQuote[] {
  const candidates = [payload?.rates, payload?.data?.rates, payload?.data?.attributes?.rates].find(Array.isArray) ?? [];
  return candidates.map((rate: any) => ({
    quote_id: String(rate.id ?? rate.rate_id),
    provider: String(rate.provider_name ?? rate.carrier_name ?? "skydropx"),
    service: String(rate.provider_service_name ?? rate.provider_service_code ?? "standard"),
    price_mxn: Math.round(Number(rate.total ?? rate.amount ?? rate.price ?? 0)),
    eta_days: Math.max(1, Math.round(Number(rate.days ?? 5))),
    quotation_id: quotationId
  })).filter((rate: ShippingQuote) => rate.quote_id && rate.price_mxn >= 0);
}

function destination(address: Record<string, any>) {
  return {
    country_code: address.country ?? "MX", postal_code: address.postal_code,
    area_level1: address.state, area_level2: address.city, area_level3: address.city
  };
}

export async function quoteNational(address: Record<string, any>, orderId?: string): Promise<ShippingQuote[]> {
  if (config.SKYDROPX_MODE === "mock") return [{ quote_id: "national-standard", provider: "skydropx", service: "standard", price_mxn: config.NATIONAL_SHIPPING_COST_MXN, eta_days: 5 }];
  const token = await accessToken();
  const response = await fetch(`${config.SKYDROPX_BASE_URL}/api/v1/quotations`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ quotation: {
      address_from: { country_code: config.SHIP_FROM_COUNTRY_CODE, postal_code: config.SHIP_FROM_POSTAL_CODE, area_level1: config.SHIP_FROM_AREA_LEVEL1, area_level2: config.SHIP_FROM_AREA_LEVEL2, area_level3: config.SHIP_FROM_AREA_LEVEL3 },
      address_to: destination(address), parcels: [{ weight: config.DEFAULT_PARCEL_WEIGHT_KG, length: config.DEFAULT_PARCEL_LENGTH_CM, width: config.DEFAULT_PARCEL_WIDTH_CM, height: config.DEFAULT_PARCEL_HEIGHT_CM }],
      requested_carriers: config.SKYDROPX_REQUESTED_CARRIERS ? config.SKYDROPX_REQUESTED_CARRIERS.split(",").map((v) => v.trim()).filter(Boolean) : null,
      order_id: orderId ?? null
    } })
  });
  if (!response.ok) throw new HttpError(503, `Skydropx quotation falló (${response.status}): ${await response.text()}`);
  let payload = await response.json();
  const quotationId = String((payload as any)?.id ?? (payload as any)?.data?.id ?? "") || undefined;
  let rates = ratesFrom(payload, quotationId);
  if (!rates.length && quotationId) {
    const lookup = await fetch(`${config.SKYDROPX_BASE_URL}/api/v1/quotations/${quotationId}`, { headers: { authorization: `Bearer ${token}` } });
    if (lookup.ok) { payload = await lookup.json(); rates = ratesFrom(payload, quotationId); }
  }
  if (!rates.length) throw new HttpError(503, "Skydropx no devolvió tarifas");
  return rates;
}

export async function createNationalShipment(order: any, rateId: string, input: Record<string, any>): Promise<any> {
  if (config.SKYDROPX_MODE === "mock") {
    const id = `mock_${randomUUID()}`;
    const tracking_number = `SAUT${id.replaceAll("-", "").slice(-12).toUpperCase()}`;
    return { provider_shipment_id: id, tracking_number, tracking_carrier: "Skydropx", tracking_url: `https://mock.skydropx.local/track/${tracking_number}`, label_url: `https://mock.skydropx.local/labels/${id}.pdf`, raw: { mode: "mock" } };
  }
  const token = await accessToken();
  const address = asObject(order.address);
  const response = await fetch(`${config.SKYDROPX_BASE_URL}/api/v1/shipments/`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ shipment: {
      rate_id: rateId, printing_format: input.printing_format ?? "standard",
      address_from: { street1: config.SHIP_FROM_STREET1, name: config.SHIP_FROM_NAME, phone: config.SHIP_FROM_PHONE, email: config.SHIP_FROM_EMAIL, country_code: config.SHIP_FROM_COUNTRY_CODE, postal_code: config.SHIP_FROM_POSTAL_CODE, area_level1: config.SHIP_FROM_AREA_LEVEL1, area_level2: config.SHIP_FROM_AREA_LEVEL2, area_level3: config.SHIP_FROM_AREA_LEVEL3 },
      address_to: { street1: address.line1, name: order.customer_email, phone: order.customer_phone, email: order.customer_email, reference: address.reference ?? address.line2 ?? null, ...destination(address) },
      packages: [{ package_number: 1, package_protected: false, declared_value: input.declared_value ?? order.total_mxn, consignment_note: input.consignment_note ?? null, package_type: input.package_type ?? null }]
    } })
  });
  if (!response.ok) throw new HttpError(503, `Skydropx shipment falló (${response.status}): ${await response.text()}`);
  const payload = await response.json();
  const provider_shipment_id = String((payload as any)?.data?.id ?? (payload as any)?.id ?? "");
  const tracking_number = String(findDeep(payload, "tracking_number") ?? "");
  if (!provider_shipment_id || !tracking_number) throw new HttpError(503, "Skydropx no devolvió shipment/tracking");
  return { provider_shipment_id, tracking_number, tracking_carrier: String(findDeep(payload, "carrier_name") ?? "Skydropx"), tracking_url: findDeep(payload, "tracking_url_provider") ?? null, label_url: findDeep(payload, "label_url") ?? null, raw: payload };
}

export async function fetchTracking(trackingNumber: string, carrier: string): Promise<{ delivered: boolean; events: any[]; raw: unknown }> {
  if (config.SKYDROPX_MODE === "mock") return { delivered: false, events: [{ status: "in_transit", description: "En tránsito", happened_at: new Date().toISOString() }], raw: { mode: "mock" } };
  const token = await accessToken();
  const url = new URL(`${config.SKYDROPX_BASE_URL}/api/v1/shipments/tracking`); url.searchParams.set("tracking_number", trackingNumber); url.searchParams.set("carrier_name", carrier);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new HttpError(503, `Skydropx tracking falló (${response.status})`);
  const raw = await response.json(); const data = Array.isArray((raw as any)?.data) ? (raw as any).data : [];
  const events = data.map((item: any) => item.attributes ?? item); const delivered = events.some((event: any) => `${event.description ?? ""} ${event.status ?? event.substatus ?? ""}`.toLowerCase().match(/delivered|entregado/));
  return { delivered, events, raw };
}
