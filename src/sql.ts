import type { Queryable } from "./db.js";
import { HttpError } from "./platform.js";

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function insertRow<T extends Record<string, any>>(
  client: Queryable,
  table: string,
  input: Record<string, any>,
  allowed: readonly string[],
  defaults: Record<string, any> = {}
): Promise<T> {
  const data = { ...defaults, ...input };
  const keys = allowed.filter((key) => data[key] !== undefined);
  if (keys.length === 0) throw new HttpError(400, "Payload vacío");
  const values = keys.map((key) => data[key]);
  const params = keys.map((_, index) => `$${index + 1}`);
  const result = await client.query<T>(
    `insert into ${quote(table)} (${keys.map(quote).join(",")}) values (${params.join(",")}) returning *`,
    values
  );
  return result.rows[0] as T;
}

export async function patchRow<T extends Record<string, any>>(
  client: Queryable,
  table: string,
  id: string | number,
  input: Record<string, any>,
  allowed: readonly string[],
  touchUpdatedAt = true
): Promise<T> {
  const keys = allowed.filter((key) => input[key] !== undefined);
  if (keys.length === 0) throw new HttpError(400, "Payload vacío");
  const values = keys.map((key) => input[key]);
  values.push(id);
  const set = keys.map((key, index) => `${quote(key)}=$${index + 1}`);
  if (touchUpdatedAt) set.push("updated_at=now()");
  const result = await client.query<T>(
    `update ${quote(table)} set ${set.join(",")} where id=$${values.length} returning *`,
    values
  );
  if (!result.rows[0]) throw new HttpError(404, "Registro no encontrado");
  return result.rows[0];
}

export async function deleteRow(client: Queryable, table: string, id: string | number): Promise<void> {
  const result = await client.query(`delete from ${quote(table)} where id=$1`, [id]);
  if (!result.rowCount) throw new HttpError(404, "Registro no encontrado");
}
