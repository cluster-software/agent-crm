import { AcrmError, ERR } from "../lib/errors.js";
import type { AcrmDatabase, Row, SqlValue } from "./types.js";

export type { Row };

// Object slugs seeded by `acrm init`. When a user/agent reaches for one of
// these as a SQL table, the missing-table hint is upgraded to call out the EAV
// shape with a copy-paste fix.
const KNOWN_OBJECT_SLUGS = new Set([
  "people",
  "companies",
  "deals",
  "posts",
  "transcripts",
]);

function extractMissingTableName(message: string): string | null {
  const quoted = /['"`]([A-Za-z_][\w.]*)['"`]/.exec(message);
  const bare = quoted ? null : /\b(?:table|relation)\s+([A-Za-z_][\w.]*)/i.exec(message);
  const m = quoted ?? bare;
  if (!m) return null;
  const raw = m[1] ?? "";
  const tail = raw.includes(".") ? raw.split(".").pop()! : raw;
  return tail.toLowerCase();
}

export async function exec(
  db: AcrmDatabase,
  sql: string,
  params: ReadonlyArray<SqlValue> = [],
): Promise<{ rows: Row[]; rowsAffected: number }> {
  try {
    return await db.execute(sql, params);
  } catch (e) {
    if (isDatabaseError(e)) {
      const code = e.code ?? (isMissingRelationError(e.message) ? "42P01" : undefined);
      let hint: string | undefined = e.hint;
      if (code === "42P01") {
        const slug = extractMissingTableName(e.message);
        if (slug && KNOWN_OBJECT_SLUGS.has(slug)) {
          hint =
            `\`${slug}\` is an object_slug, not a table. Try: ` +
            `\`SELECT record_id FROM acrm_record WHERE object_slug='${slug}'\`. ` +
            `To read fields, pivot from acrm_value (filter active_until IS NULL). ` +
            `Run \`acrm execute --help\` for the full EAV cheat-sheet.`;
        } else {
          hint = `Records are EAV: try \`acrm execute "SELECT object_slug, COUNT(*) FROM acrm_record GROUP BY object_slug"\` to see what's loaded, then query acrm_value for attribute values.`;
        }
      }
      throw new AcrmError(
        e.message,
        code ? `POSTGRES_${code}` : ERR.EXECUTE,
        hint,
        e,
      );
    }
    throw e;
  }
}

export async function execOne(
  db: AcrmDatabase,
  sql: string,
  params: ReadonlyArray<SqlValue> = [],
): Promise<Row | null> {
  const { rows } = await exec(db, sql, params);
  return rows[0] ?? null;
}

export async function execScalar<T = unknown>(
  db: AcrmDatabase,
  sql: string,
  params: ReadonlyArray<SqlValue> = [],
): Promise<T | null> {
  const row = await execOne(db, sql, params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? (row[keys[0]!] as T) : null;
}

function isDatabaseError(error: unknown): error is {
  code?: string;
  message: string;
  hint?: string;
} {
  return (
    error instanceof Error &&
    (typeof (error as { code?: unknown }).code === "string" ||
      isMissingRelationError(error.message))
  );
}

function isMissingRelationError(message: string): boolean {
  return /\b(?:relation|table)\s+["']?[A-Za-z_][\w.]*["']?\s+does not exist/i.test(message);
}
