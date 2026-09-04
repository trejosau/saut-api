import { HttpError } from "../platform.js";

export const SUPPORTED_GARMENT_TYPES = ["tshirt", "hoodie"] as const;
export type SupportedGarmentType = (typeof SUPPORTED_GARMENT_TYPES)[number];

export function isSupportedGarmentType(value: unknown): value is SupportedGarmentType {
  return typeof value === "string" && SUPPORTED_GARMENT_TYPES.includes(value as SupportedGarmentType);
}

export function requireSupportedGarmentType(value: unknown): SupportedGarmentType {
  if (!isSupportedGarmentType(value)) {
    throw new HttpError(422, "Tipo de prenda no soportado");
  }
  return value;
}
