import type { Lix, LixRuntimeValue } from "@lix-js/sdk";
import { isLixError } from "@lix-js/sdk";
import { AcrmError, ERR } from "../lib/errors.js";

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
      const msg = (e as Error).message;
      if (/conflict/i.test(msg)) throw new AcrmError(msg, ERR.MERGE_CONFLICT);
      throw new AcrmError(msg, ERR.WRITE_REJECTED);
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
