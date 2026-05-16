import type { Lix, LixRuntimeValue } from "@lix-js/sdk";
import { isLixError } from "@lix-js/sdk";
import { AcrmError } from "../lib/errors.js";

export type Row = Record<string, unknown>;

// Object slugs seeded by `acrm init`. When a user/agent reaches for one of
// these as a SQL table, the LIX_TABLE_NOT_FOUND hint is upgraded to call out
// the EAV shape with a copy-paste fix.
const KNOWN_OBJECT_SLUGS = new Set([
  "people",
  "companies",
  "deals",
  "posts",
  "transcripts",
]);

function extractMissingTableName(message: string): string | null {
  // Lix surfaces messages like:
  //   "Error during planning: table 'datafusion.public.people' not found"
  // We want just the tail identifier ("people"). Accept dot-qualified names
  // inside the quoted segment, then peel off the schema prefix.
  const quoted = /['"`]([A-Za-z_][\w.]*)['"`]/.exec(message);
  const bare = quoted ? null : /\btable\s+([A-Za-z_][\w.]*)/i.exec(message);
  const m = quoted ?? bare;
  if (!m) return null;
  const raw = m[1] ?? "";
  const tail = raw.includes(".") ? raw.split(".").pop()! : raw;
  return tail.toLowerCase();
}

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
      let hint = e.hint;
      if (e.code === "LIX_TABLE_NOT_FOUND") {
        const slug = extractMissingTableName(e.message);
        if (slug && KNOWN_OBJECT_SLUGS.has(slug)) {
          // Catch the exact mistake at the moment it happens, with the exact
          // fix inline. Agents reaching for `select * from people` learn the
          // EAV shape from the error rather than from the docs after the fact.
          hint =
            `\`${slug}\` is an object_slug, not a table. Try: ` +
            `\`SELECT record_id FROM acrm_record WHERE object_slug='${slug}'\`. ` +
            `To read fields, pivot from acrm_value (filter active_until IS NULL). ` +
            `Run \`acrm execute --help\` for the full EAV cheat-sheet.`;
        } else {
          hint = `Records are EAV: try \`acrm execute "SELECT object_slug, COUNT(*) FROM acrm_record GROUP BY object_slug"\` to see what's loaded, then query acrm_value for attribute values.`;
        }
      }
      throw new AcrmError(e.message, e.code, hint, e.details);
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
