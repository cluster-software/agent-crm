import { createInterface } from "node:readline";
import type { Command } from "commander";
import type { Lix } from "@lix-js/sdk";
import { openWorkspace } from "../workspace/open.js";
import { exec } from "../db/execute.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";
import { AcrmError, ERR } from "../lib/errors.js";
import { nowIso } from "../lib/time.js";

type Prefer = "keep" | "discard" | "interactive";

type Opts = {
  keep: string;
  discard: string;
  dryRun?: boolean;
  prefer?: string;
  json?: boolean;
};

type ValueRow = {
  id: string;
  attribute_slug: string;
  attribute_type: string;
  value_json: string;
  normalized_key: string | null;
  ref_object: string | null;
  ref_record_id: string | null;
};

type InboundRow = ValueRow & {
  object_slug: string;
  record_id: string;
};

type AttributeMeta = {
  attribute_type: string;
  is_multivalued: boolean;
};

export type DedupePlanItem =
  | {
      kind: "move_multi";
      attribute_slug: string;
      from_value_id: string;
      normalized_key: string | null;
      ref_record_id: string | null;
    }
  | {
      kind: "drop_multi_duplicate";
      attribute_slug: string;
      from_value_id: string;
      normalized_key: string | null;
      ref_record_id: string | null;
    }
  | {
      kind: "move_single_empty_keeper";
      attribute_slug: string;
      from_value_id: string;
    }
  | {
      kind: "single_conflict_keep_wins";
      attribute_slug: string;
      kept_value_id: string;
      dropped_value_id: string;
    }
  | {
      kind: "single_conflict_discard_wins";
      attribute_slug: string;
      kept_value_id: string;
      dropped_value_id: string;
    }
  | {
      kind: "inbound_redirect";
      object_slug: string;
      record_id: string;
      attribute_slug: string;
      value_id: string;
    }
  | {
      kind: "inbound_drop_duplicate";
      object_slug: string;
      record_id: string;
      attribute_slug: string;
      value_id: string;
    };

export type DedupePlan = {
  object_slug: string;
  keep_record_id: string;
  discard_record_id: string;
  prefer: Prefer;
  items: DedupePlanItem[];
  conflicts: Array<{
    attribute_slug: string;
    keeper_value_json: unknown;
    discard_value_json: unknown;
    resolution: "keep" | "discard";
  }>;
};

export type DedupeResult = DedupePlan & {
  applied: boolean;
  values_moved: number;
  values_dropped: number;
  inbound_redirected: number;
  inbound_dropped: number;
  discard_record_deleted: boolean;
};

export function registerRecords(program: Command): void {
  // Namespace `records` carves out room for future per-record operations
  // (archive, restore, show, list) without crowding the top-level surface.
  // `dedupe` is the verb agents and humans reach for when two rows describe
  // the same entity — chosen over `merge` to keep clear of lix's branch /
  // version merge terminology.
  const records = program
    .command("records")
    .description(
      "operations on records as a group (dedupe duplicates, etc.). Subcommands act on any object — `people`, `companies`, `deals`, `posts`, `transcripts`.",
    );

  records
    .command("dedupe <object>")
    .description(
      "collapse two duplicate records of the same object into one: reassign attribute values + inbound references from `--discard` to `--keep`, then delete the discarded record. Use when two `people`/`companies`/etc. records describe the same entity (e.g. one created from a LinkedIn import and a duplicate created from a transcript email).",
    )
    .requiredOption("--keep <record_id>", "the record to keep (winner)")
    .requiredOption("--discard <record_id>", "the record to delete (loser)")
    .option(
      "--prefer <policy>",
      "conflict policy for single-valued attributes: keep | discard | interactive (default: keep)",
      "keep",
    )
    .option(
      "--dry-run",
      "print the plan (rows moved, rows redirected, conflicts) without applying",
    )
    .addHelpText(
      "after",
      `
Examples:
  acrm records dedupe people --keep <luis-1> --discard <luis-2>
  acrm records dedupe people --keep <luis-1> --discard <luis-2> --dry-run
  acrm records dedupe people --keep <luis-1> --discard <luis-2> --prefer discard
  acrm records dedupe companies --keep <co-1> --discard <co-2>

What it does:
  1. Reassigns every \`acrm_value\` row from the discard to the keeper.
     - Multivalued attrs: dedupe by normalized_key (or ref_record_id for refs).
     - Single-valued attrs: keeper wins by default; \`--prefer discard\` flips it;
       \`--prefer interactive\` prompts on each conflict.
  2. Rewrites every inbound reference (acrm_value rows where
     ref_record_id = discard) to point at the keeper. Dedupes if the source
     record already had an active ref to the keeper.
  3. Deletes the discarded record from \`acrm_record\`.

Note: lix does not currently expose BEGIN/COMMIT, so this command is not a
single SQL transaction. It validates the full plan before any mutation
(use \`--dry-run\` to inspect). If a step fails midway, re-run the command —
the operation is idempotent once the duplicate row has been redirected.
`,
    )
    .action(async (object: string, opts: Opts) => {
      const root = program.opts() as { json?: boolean; workspace?: string };
      setJsonMode(root.json);
      try {
        const prefer = parsePrefer(opts.prefer);
        const lix = await openWorkspace({ workspace: root.workspace });
        try {
          const result = await dedupeRecords(lix, {
            object_slug: object,
            keep_record_id: opts.keep,
            discard_record_id: opts.discard,
            prefer,
            dryRun: Boolean(opts.dryRun),
          });
          ok(result);
          if (!isJson() && opts.dryRun) {
            process.stderr.write(`(dry-run — no changes applied)\n`);
          }
        } finally {
          await lix.close();
        }
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });
}

function parsePrefer(input: string | undefined): Prefer {
  if (!input) return "keep";
  const s = input.trim().toLowerCase();
  if (s === "keep" || s === "discard" || s === "interactive") return s;
  throw new AcrmError(
    `invalid --prefer value: ${input} (expected keep | discard | interactive)`,
    ERR.INVALID_INPUT,
  );
}

export async function dedupeRecords(
  lix: Lix,
  args: {
    object_slug: string;
    keep_record_id: string;
    discard_record_id: string;
    prefer: Prefer;
    dryRun: boolean;
  },
): Promise<DedupeResult> {
  const { object_slug, keep_record_id, discard_record_id, prefer, dryRun } =
    args;

  if (keep_record_id === discard_record_id) {
    throw new AcrmError(
      "--keep and --discard are the same record_id",
      ERR.INVALID_INPUT,
    );
  }

  await assertRecordExists(lix, object_slug, keep_record_id, "keep");
  await assertRecordExists(lix, object_slug, discard_record_id, "discard");

  const attrs = await loadAttributeMeta(lix, object_slug);

  const discardValues = await loadActiveValues(
    lix,
    object_slug,
    discard_record_id,
  );
  const keeperValues = await loadActiveValues(
    lix,
    object_slug,
    keep_record_id,
  );

  const items: DedupePlanItem[] = [];
  const conflicts: DedupeResult["conflicts"] = [];

  // Index keeper values by attribute for O(1) lookups during planning.
  const keeperByAttr = new Map<string, ValueRow[]>();
  for (const v of keeperValues) {
    const list = keeperByAttr.get(v.attribute_slug) ?? [];
    list.push(v);
    keeperByAttr.set(v.attribute_slug, list);
  }

  for (const v of discardValues) {
    const meta = attrs.get(v.attribute_slug);
    // Unknown attribute (orphan attribute_slug) — preserve by moving; safer
    // than dropping data we don't have schema for.
    const multivalued = meta?.is_multivalued ?? false;
    const keeperRows = keeperByAttr.get(v.attribute_slug) ?? [];

    if (multivalued) {
      const dupeKey = duplicateKey(v);
      const isDupe =
        dupeKey !== null &&
        keeperRows.some((k) => duplicateKey(k) === dupeKey);
      if (isDupe) {
        items.push({
          kind: "drop_multi_duplicate",
          attribute_slug: v.attribute_slug,
          from_value_id: v.id,
          normalized_key: v.normalized_key,
          ref_record_id: v.ref_record_id,
        });
      } else {
        items.push({
          kind: "move_multi",
          attribute_slug: v.attribute_slug,
          from_value_id: v.id,
          normalized_key: v.normalized_key,
          ref_record_id: v.ref_record_id,
        });
        // So that subsequent discard rows in the same attribute see the new
        // keeper-side value during dedup.
        keeperRows.push(v);
        keeperByAttr.set(v.attribute_slug, keeperRows);
      }
    } else {
      // Single-valued: at most one active row per side.
      const keeperRow = keeperRows[0];
      if (!keeperRow) {
        items.push({
          kind: "move_single_empty_keeper",
          attribute_slug: v.attribute_slug,
          from_value_id: v.id,
        });
        keeperByAttr.set(v.attribute_slug, [v]);
      } else if (sameValue(keeperRow, v)) {
        // Same value on both sides — just drop the discard's row.
        items.push({
          kind: "drop_multi_duplicate",
          attribute_slug: v.attribute_slug,
          from_value_id: v.id,
          normalized_key: v.normalized_key,
          ref_record_id: v.ref_record_id,
        });
      } else {
        const resolution = await resolveConflict(
          v.attribute_slug,
          keeperRow,
          v,
          prefer,
        );
        if (resolution === "keep") {
          items.push({
            kind: "single_conflict_keep_wins",
            attribute_slug: v.attribute_slug,
            kept_value_id: keeperRow.id,
            dropped_value_id: v.id,
          });
        } else {
          items.push({
            kind: "single_conflict_discard_wins",
            attribute_slug: v.attribute_slug,
            kept_value_id: v.id,
            dropped_value_id: keeperRow.id,
          });
        }
        conflicts.push({
          attribute_slug: v.attribute_slug,
          keeper_value_json: safeJson(keeperRow.value_json),
          discard_value_json: safeJson(v.value_json),
          resolution,
        });
      }
    }
  }

  const inbound = await loadInboundRefs(lix, object_slug, discard_record_id);

  // Group inbound by (record_id, attribute_slug) so we can dedupe duplicates
  // that would otherwise point a single source record at the keeper twice.
  const keeperInboundKeys = new Set<string>();
  const keeperInbound = await loadKeeperInbound(lix, object_slug, keep_record_id);
  for (const k of keeperInbound) {
    keeperInboundKeys.add(`${k.object_slug}|${k.record_id}|${k.attribute_slug}`);
  }

  for (const i of inbound) {
    const key = `${i.object_slug}|${i.record_id}|${i.attribute_slug}`;
    if (keeperInboundKeys.has(key)) {
      items.push({
        kind: "inbound_drop_duplicate",
        object_slug: i.object_slug,
        record_id: i.record_id,
        attribute_slug: i.attribute_slug,
        value_id: i.id,
      });
    } else {
      items.push({
        kind: "inbound_redirect",
        object_slug: i.object_slug,
        record_id: i.record_id,
        attribute_slug: i.attribute_slug,
        value_id: i.id,
      });
      keeperInboundKeys.add(key);
    }
  }

  const plan: DedupePlan = {
    object_slug,
    keep_record_id,
    discard_record_id,
    prefer,
    items,
    conflicts,
  };

  if (dryRun) {
    return {
      ...plan,
      applied: false,
      values_moved: items.filter(
        (i) => i.kind === "move_multi" || i.kind === "move_single_empty_keeper",
      ).length,
      values_dropped: items.filter(
        (i) =>
          i.kind === "drop_multi_duplicate" ||
          i.kind === "single_conflict_keep_wins" ||
          i.kind === "single_conflict_discard_wins",
      ).length,
      inbound_redirected: items.filter((i) => i.kind === "inbound_redirect")
        .length,
      inbound_dropped: items.filter((i) => i.kind === "inbound_drop_duplicate")
        .length,
      discard_record_deleted: false,
    };
  }

  let movedCount = 0;
  let droppedCount = 0;
  let redirectedCount = 0;
  let inboundDroppedCount = 0;

  const ts = nowIso();
  for (const item of items) {
    switch (item.kind) {
      case "move_multi":
      case "move_single_empty_keeper": {
        await exec(
          lix,
          `UPDATE acrm_value SET record_id = $1 WHERE id = $2`,
          [keep_record_id, item.from_value_id],
        );
        movedCount++;
        break;
      }
      case "drop_multi_duplicate": {
        await exec(
          lix,
          `UPDATE acrm_value SET active_until = $1 WHERE id = $2`,
          [ts, item.from_value_id],
        );
        droppedCount++;
        break;
      }
      case "single_conflict_keep_wins": {
        await exec(
          lix,
          `UPDATE acrm_value SET active_until = $1 WHERE id = $2`,
          [ts, item.dropped_value_id],
        );
        droppedCount++;
        break;
      }
      case "single_conflict_discard_wins": {
        // Soft-delete the keeper's existing value, then move the discard's
        // value over to the keeper record.
        await exec(
          lix,
          `UPDATE acrm_value SET active_until = $1 WHERE id = $2`,
          [ts, item.dropped_value_id],
        );
        await exec(
          lix,
          `UPDATE acrm_value SET record_id = $1 WHERE id = $2`,
          [keep_record_id, item.kept_value_id],
        );
        droppedCount++;
        movedCount++;
        break;
      }
      case "inbound_redirect": {
        // Rewrite both columns: the indexed `ref_record_id` column and the
        // embedded `target_record_id` field inside value_json. Lix's
        // DataFusion dialect doesn't expose JSON UPDATE, so we round-trip
        // through JS.
        const cur = await exec(
          lix,
          `SELECT value_json FROM acrm_value WHERE id = $1`,
          [item.value_id],
        );
        const raw = cur.rows[0]?.value_json as string | undefined;
        let nextJson = raw;
        if (raw) {
          try {
            const obj = JSON.parse(raw) as Record<string, unknown>;
            if (typeof obj.target_record_id === "string") {
              obj.target_record_id = keep_record_id;
              nextJson = JSON.stringify(obj);
            }
          } catch {
            // Leave value_json untouched if it's not the expected shape —
            // the ref_record_id column is the index of record, value_json
            // is denormalized cache.
          }
        }
        await exec(
          lix,
          `UPDATE acrm_value
           SET ref_record_id = $1, value_json = $2
           WHERE id = $3`,
          [keep_record_id, nextJson ?? null, item.value_id],
        );
        redirectedCount++;
        break;
      }
      case "inbound_drop_duplicate": {
        await exec(
          lix,
          `UPDATE acrm_value SET active_until = $1 WHERE id = $2`,
          [ts, item.value_id],
        );
        inboundDroppedCount++;
        break;
      }
    }
  }

  // Discard the empty record. acrm_value rows still tagged with the discard's
  // record_id (e.g. soft-deleted ones) are intentionally left in place as a
  // history trail.
  await exec(
    lix,
    `DELETE FROM acrm_record WHERE object_slug = $1 AND record_id = $2`,
    [object_slug, discard_record_id],
  );

  return {
    ...plan,
    applied: true,
    values_moved: movedCount,
    values_dropped: droppedCount,
    inbound_redirected: redirectedCount,
    inbound_dropped: inboundDroppedCount,
    discard_record_deleted: true,
  };
}

async function assertRecordExists(
  lix: Lix,
  object_slug: string,
  record_id: string,
  side: "keep" | "discard",
): Promise<void> {
  const r = await exec(
    lix,
    `SELECT 1 FROM acrm_record WHERE object_slug = $1 AND record_id = $2`,
    [object_slug, record_id],
  );
  if (!r.rows.length) {
    throw new AcrmError(
      `--${side} record_id not found: ${record_id} (object_slug=${object_slug})`,
      ERR.NOT_FOUND,
    );
  }
}

async function loadAttributeMeta(
  lix: Lix,
  object_slug: string,
): Promise<Map<string, AttributeMeta>> {
  const r = await exec(
    lix,
    `SELECT attribute_slug, attribute_type, is_multivalued
     FROM acrm_attribute WHERE object_slug = $1`,
    [object_slug],
  );
  const out = new Map<string, AttributeMeta>();
  for (const row of r.rows) {
    out.set(row.attribute_slug as string, {
      attribute_type: row.attribute_type as string,
      is_multivalued: Boolean(row.is_multivalued),
    });
  }
  return out;
}

async function loadActiveValues(
  lix: Lix,
  object_slug: string,
  record_id: string,
): Promise<ValueRow[]> {
  const r = await exec(
    lix,
    `SELECT id, attribute_slug, attribute_type, value_json, normalized_key,
            ref_object, ref_record_id
     FROM acrm_value
     WHERE object_slug = $1 AND record_id = $2 AND active_until IS NULL`,
    [object_slug, record_id],
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    attribute_slug: row.attribute_slug as string,
    attribute_type: row.attribute_type as string,
    value_json: (row.value_json as string | null) ?? "",
    normalized_key: (row.normalized_key as string | null) ?? null,
    ref_object: (row.ref_object as string | null) ?? null,
    ref_record_id: (row.ref_record_id as string | null) ?? null,
  }));
}

async function loadInboundRefs(
  lix: Lix,
  ref_object: string,
  ref_record_id: string,
): Promise<InboundRow[]> {
  const r = await exec(
    lix,
    `SELECT id, object_slug, record_id, attribute_slug, attribute_type,
            value_json, normalized_key, ref_object, ref_record_id
     FROM acrm_value
     WHERE ref_object = $1 AND ref_record_id = $2 AND active_until IS NULL`,
    [ref_object, ref_record_id],
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    object_slug: row.object_slug as string,
    record_id: row.record_id as string,
    attribute_slug: row.attribute_slug as string,
    attribute_type: row.attribute_type as string,
    value_json: (row.value_json as string | null) ?? "",
    normalized_key: (row.normalized_key as string | null) ?? null,
    ref_object: (row.ref_object as string | null) ?? null,
    ref_record_id: (row.ref_record_id as string | null) ?? null,
  }));
}

async function loadKeeperInbound(
  lix: Lix,
  ref_object: string,
  ref_record_id: string,
): Promise<InboundRow[]> {
  return loadInboundRefs(lix, ref_object, ref_record_id);
}

function duplicateKey(v: ValueRow): string | null {
  // Prefer ref_record_id for record-references; normalized_key for everything
  // else. If neither exists (e.g. free-text multivalued without normalization),
  // the row cannot be deduped and is always moved.
  if (v.ref_record_id) return `ref:${v.ref_record_id}`;
  if (v.normalized_key) return `key:${v.normalized_key}`;
  return null;
}

function sameValue(a: ValueRow, b: ValueRow): boolean {
  // Cheap structural equality. value_json is small JSON; if the same fields
  // appear in different order it still compares unequal, which is fine — the
  // worst case is treating two structurally identical rows as a conflict and
  // letting the conflict policy resolve it (defaulting to keep, so no data
  // loss).
  if (a.ref_record_id && b.ref_record_id) {
    return a.ref_record_id === b.ref_record_id;
  }
  if (a.normalized_key && b.normalized_key) {
    return a.normalized_key === b.normalized_key;
  }
  return a.value_json === b.value_json;
}

function safeJson(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function resolveConflict(
  attribute_slug: string,
  keeperRow: ValueRow,
  discardRow: ValueRow,
  prefer: Prefer,
): Promise<"keep" | "discard"> {
  if (prefer === "keep") return "keep";
  if (prefer === "discard") return "discard";
  // interactive
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(
      `\nconflict on ${attribute_slug}:\n` +
        `  keep    → ${truncate(keeperRow.value_json)}\n` +
        `  discard → ${truncate(discardRow.value_json)}\n`,
    );
    const answer = await new Promise<string>((resolve) =>
      rl.question("which to keep? [k=keep / d=discard] ", resolve),
    );
    const s = answer.trim().toLowerCase();
    return s.startsWith("d") ? "discard" : "keep";
  } finally {
    rl.close();
  }
}

function truncate(s: string, n = 80): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}
