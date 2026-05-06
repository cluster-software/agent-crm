import type { Lix, LixRuntimeValue } from "@lix-js/sdk";
import { isLixError } from "@lix-js/sdk";
import { AcrmError } from "../lib/errors.js";

export type Row = Record<string, unknown>;

export async function exec(
  lix: Lix,
  sql: string,
  params: ReadonlyArray<LixRuntimeValue> = [],
): Promise<{ rows: Row[]; rowsAffected: number }> {
  try {
    const result = await lix.execute(sql, params);
    const rows: Row[] = result.rows.map((r) => r.toObject());
    return { rows, rowsAffected: result.rowsAffected };
  } catch (e) {
    if (isLixError(e)) {
      // Surface the engine's own code + hint instead of collapsing to a single
      // ACRM_ERROR_*. The lix engine speaks Postgres-style errors:
      // `message` says what's wrong, `hint` (when present) says how to fix it.
      throw new AcrmError(e.message, e.code, e.hint, e.details);
    }
    throw e;
  }
}

export async function execOne(
  lix: Lix,
  sql: string,
  params: ReadonlyArray<LixRuntimeValue> = [],
): Promise<Row | null> {
  const { rows } = await exec(lix, sql, params);
  return rows[0] ?? null;
}

export async function execScalar<T = unknown>(
  lix: Lix,
  sql: string,
  params: ReadonlyArray<LixRuntimeValue> = [],
): Promise<T | null> {
  const row = await execOne(lix, sql, params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? (row[keys[0]!] as T) : null;
}
