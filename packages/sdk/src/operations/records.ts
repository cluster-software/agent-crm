import type { Lix } from "@lix-js/sdk";
import { exec } from "../db/execute.js";
import {
  addMultiValue,
  insertRecord,
  setSingleValue,
} from "../db/upsert.js";
import {
  encode,
  type AttributeConfig,
  type AttributeType,
} from "../domain/values.js";
import { AcrmError, ERR } from "../lib/errors.js";
import { generateUuid } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import {
  assertObjectExists,
  loadAttribute as loadCatalogAttribute,
} from "../workspace/catalog.js";
import type { Workspace } from "../workspace.js";

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

export type DedupePolicy = "keep" | "discard";

export type ConflictInfo = {
  attribute_slug: string;
  keeper_value_json: unknown;
  discard_value_json: unknown;
};

// Either a static policy or an async callback the SDK consults for each
// single-value conflict. The CLI's `--prefer interactive` mode uses the
// callback form (a readline prompt); programmatic callers pass `"keep"` or
// `"discard"` for a uniform policy.
export type ConflictResolver =
  | DedupePolicy
  | ((info: ConflictInfo) => Promise<DedupePolicy> | DedupePolicy);

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
  prefer: DedupePolicy;
  items: DedupePlanItem[];
  conflicts: Array<{
    attribute_slug: string;
    keeper_value_json: unknown;
    discard_value_json: unknown;
    resolution: DedupePolicy;
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

export type PlanDedupeInput = {
  object_slug: string;
  keep_record_id: string;
  discard_record_id: string;
  // Default "keep". Pass a callback to resolve each single-value conflict
  // dynamically (e.g. interactive prompt).
  resolveConflict?: ConflictResolver;
};

// Compute the rewrite plan for collapsing `discard_record_id` into
// `keep_record_id` of the same object. Pure (no mutation). Call
// `applyDedupe(workspace, plan)` to execute.
export async function planDedupe(
  workspace: Workspace,
  input: PlanDedupeInput,
): Promise<DedupePlan> {
  const lix = workspace.lix;
  const { object_slug, keep_record_id, discard_record_id } = input;
  const resolver: ConflictResolver = input.resolveConflict ?? "keep";

  if (keep_record_id === discard_record_id) {
    throw new AcrmError(
      "keep and discard are the same record_id",
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
  const conflicts: DedupePlan["conflicts"] = [];

  const keeperByAttr = new Map<string, ValueRow[]>();
  for (const v of keeperValues) {
    const list = keeperByAttr.get(v.attribute_slug) ?? [];
    list.push(v);
    keeperByAttr.set(v.attribute_slug, list);
  }

  for (const v of discardValues) {
    const meta = attrs.get(v.attribute_slug);
    const multivalued = meta?.is_multivalued ?? false;
    const keeperRows = keeperByAttr.get(v.attribute_slug) ?? [];

    if (multivalued) {
      const dupeKey = duplicateKey(v);
      const isDupe =
        dupeKey !== null && keeperRows.some((k) => duplicateKey(k) === dupeKey);
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
        keeperRows.push(v);
        keeperByAttr.set(v.attribute_slug, keeperRows);
      }
    } else {
      const keeperRow = keeperRows[0];
      if (!keeperRow) {
        items.push({
          kind: "move_single_empty_keeper",
          attribute_slug: v.attribute_slug,
          from_value_id: v.id,
        });
        keeperByAttr.set(v.attribute_slug, [v]);
      } else if (sameValue(keeperRow, v)) {
        items.push({
          kind: "drop_multi_duplicate",
          attribute_slug: v.attribute_slug,
          from_value_id: v.id,
          normalized_key: v.normalized_key,
          ref_record_id: v.ref_record_id,
        });
      } else {
        const resolution = await resolveOne(resolver, {
          attribute_slug: v.attribute_slug,
          keeper_value_json: safeJson(keeperRow.value_json),
          discard_value_json: safeJson(v.value_json),
        });
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

  const keeperInboundKeys = new Set<string>();
  const keeperInbound = await loadInboundRefs(lix, object_slug, keep_record_id);
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

  const defaultPolicy: DedupePolicy =
    typeof resolver === "string" ? resolver : "keep";
  return {
    object_slug,
    keep_record_id,
    discard_record_id,
    prefer: defaultPolicy,
    items,
    conflicts,
  };
}

async function resolveOne(
  resolver: ConflictResolver,
  info: ConflictInfo,
): Promise<DedupePolicy> {
  if (typeof resolver === "string") return resolver;
  return await resolver(info);
}

// Apply a previously-computed plan. Returns a `DedupeResult` with counts and
// `applied: true`. Idempotency: re-running after a partial apply is safe
// because moved/redirected rows are matched by primary key and the discard
// record is deleted at the end.
export async function applyDedupe(
  workspace: Workspace,
  plan: DedupePlan,
): Promise<DedupeResult> {
  const lix = workspace.lix;
  const { object_slug, keep_record_id, discard_record_id, items } = plan;

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
            // Leave value_json untouched if it's not the expected shape.
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

// Convenience: plan + (if not dryRun) apply. Most programmatic callers use
// this; CLI's `--prefer interactive` mode calls planDedupe with a callback
// directly so the prompt can run between planning and applying.
export type DedupeRecordsInput = {
  object_slug: string;
  keep_record_id: string;
  discard_record_id: string;
  prefer: DedupePolicy;
  dryRun: boolean;
};

export async function dedupeRecords(
  workspace: Workspace,
  args: DedupeRecordsInput,
): Promise<DedupeResult> {
  const plan = await planDedupe(workspace, {
    object_slug: args.object_slug,
    keep_record_id: args.keep_record_id,
    discard_record_id: args.discard_record_id,
    resolveConflict: args.prefer,
  });
  if (args.dryRun) {
    return {
      ...plan,
      applied: false,
      values_moved: plan.items.filter(
        (i) => i.kind === "move_multi" || i.kind === "move_single_empty_keeper",
      ).length,
      values_dropped: plan.items.filter(
        (i) =>
          i.kind === "drop_multi_duplicate" ||
          i.kind === "single_conflict_keep_wins" ||
          i.kind === "single_conflict_discard_wins",
      ).length,
      inbound_redirected: plan.items.filter((i) => i.kind === "inbound_redirect")
        .length,
      inbound_dropped: plan.items.filter((i) => i.kind === "inbound_drop_duplicate")
        .length,
      discard_record_deleted: false,
    };
  }
  return await applyDedupe(workspace, plan);
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
      `${side} record_id not found: ${record_id} (object_slug=${object_slug})`,
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
    `SELECT v.id, v.attribute_slug, a.attribute_type, v.value_json,
            v.normalized_key, v.ref_object, v.ref_record_id
     FROM acrm_value v
     JOIN acrm_attribute a
       ON a.object_slug = v.object_slug AND a.attribute_slug = v.attribute_slug
     WHERE v.object_slug = $1 AND v.record_id = $2 AND v.active_until IS NULL`,
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
    `SELECT v.id, v.object_slug, v.record_id, v.attribute_slug, a.attribute_type,
            v.value_json, v.normalized_key, v.ref_object, v.ref_record_id
     FROM acrm_value v
     JOIN acrm_attribute a
       ON a.object_slug = v.object_slug AND a.attribute_slug = v.attribute_slug
     WHERE v.ref_object = $1 AND v.ref_record_id = $2 AND v.active_until IS NULL`,
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

function duplicateKey(v: ValueRow): string | null {
  if (v.ref_record_id) return `ref:${v.ref_record_id}`;
  if (v.normalized_key) return `key:${v.normalized_key}`;
  return null;
}

function sameValue(a: ValueRow, b: ValueRow): boolean {
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

type AttributeRow = {
  attribute_type: AttributeType;
  is_multivalued: boolean;
  config?: AttributeConfig;
};

type PreparedField = {
  slug: string;
  attr: AttributeRow;
  value: unknown;
};

export type CreateRecordResult = {
  created: true;
  object_slug: string;
  record_id: string;
  values_inserted: number;
};

export type UpdateRecordResult = {
  updated: true;
  object_slug: string;
  record_id: string;
  values_changed: number;
};

async function assertObjectRegistered(
  lix: Lix,
  object_slug: string,
): Promise<void> {
  await assertObjectExists(
    lix,
    object_slug,
    `unknown object: ${object_slug}. Register it via createObject() or check existing objects with a SELECT against acrm_object.`,
  );
}

function parseField(raw: string): { slug: string; value: string } {
  const i = raw.indexOf("=");
  if (i <= 0) {
    throw new AcrmError(
      `invalid field: ${raw} (expected <slug>=<value>)`,
      ERR.INVALID_INPUT,
    );
  }
  return { slug: raw.slice(0, i).trim(), value: raw.slice(i + 1) };
}

function coerceFieldValue(
  attr: AttributeRow,
  attribute_slug: string,
  raw: string,
): unknown {
  if (attr.attribute_type === "record-reference") {
    const i = raw.indexOf(":");
    if (i <= 0 || i === raw.length - 1) {
      throw new AcrmError(
        `invalid record-reference value for ${attribute_slug}: ${raw} (expected <target_object>:<target_record_id>)`,
        ERR.INVALID_INPUT,
      );
    }
    return {
      target_object: raw.slice(0, i).trim(),
      target_record_id: raw.slice(i + 1).trim(),
    };
  }
  return raw;
}

// Parse + validate every field up front. encode() runs in dry-run mode here
// to catch invalid enum values, unparseable emails, etc.; doing it before any
// write means we never leave a half-populated record behind.
async function prepareFields(
  lix: Lix,
  object_slug: string,
  fields: string[],
): Promise<PreparedField[]> {
  const parsed = fields.map(parseField).filter((f) => f.value !== "");
  const attrMeta = new Map<string, AttributeRow>();
  for (const f of parsed) {
    if (attrMeta.has(f.slug)) continue;
    const attr = await loadCatalogAttribute(lix, object_slug, f.slug);
    if (!attr) {
      throw new AcrmError(
        `unknown attribute: ${object_slug}.${f.slug}. Register it via addAttribute() or check the workspace schema.`,
        ERR.NOT_FOUND,
      );
    }
    attrMeta.set(f.slug, {
      attribute_type: attr.attribute_type,
      is_multivalued: attr.is_multivalued,
      config: attr.config,
    });
  }

  return parsed.map((f) => {
    const attr = attrMeta.get(f.slug)!;
    const value = coerceFieldValue(attr, f.slug, f.value);
    encode(attr.attribute_type, value, attr.config);
    return { slug: f.slug, attr, value };
  });
}

async function applyFields(
  lix: Lix,
  object_slug: string,
  record_id: string,
  prepared: PreparedField[],
  source: string,
): Promise<number> {
  const provenance: Record<string, unknown> = { command: source };
  let n = 0;
  for (const e of prepared) {
    if (e.attr.is_multivalued) {
      await addMultiValue(lix, {
        object_slug,
        record_id,
        attribute_slug: e.slug,
        attribute_type: e.attr.attribute_type,
        value: e.value,
        source,
        provenance,
      });
    } else {
      await setSingleValue(lix, {
        object_slug,
        record_id,
        attribute_slug: e.slug,
        attribute_type: e.attr.attribute_type,
        value: e.value,
        source,
        provenance,
      });
    }
    n++;
  }
  return n;
}

export async function createRecord(
  workspace: Workspace,
  args: { object_slug: string; fields: string[]; source?: string },
): Promise<CreateRecordResult> {
  const lix = workspace.lix;
  const { object_slug, fields } = args;
  const source = args.source ?? "sdk:records-create";

  await assertObjectRegistered(lix, object_slug);
  const prepared = await prepareFields(lix, object_slug, fields);

  const record_id = await generateUuid(lix);
  await insertRecord(lix, object_slug, record_id);
  const inserted = await applyFields(lix, object_slug, record_id, prepared, source);

  return {
    created: true,
    object_slug,
    record_id,
    values_inserted: inserted,
  };
}

export async function updateRecord(
  workspace: Workspace,
  args: {
    object_slug: string;
    record_id: string;
    fields: string[];
    source?: string;
  },
): Promise<UpdateRecordResult> {
  const lix = workspace.lix;
  const { object_slug, record_id, fields } = args;
  const source = args.source ?? "sdk:records-update";

  await assertObjectRegistered(lix, object_slug);

  const exists = await exec(
    lix,
    "SELECT record_id FROM acrm_record WHERE object_slug = $1 AND record_id = $2",
    [object_slug, record_id],
  );
  if (!exists.rows.length) {
    throw new AcrmError(
      `record not found: ${object_slug}/${record_id}`,
      ERR.NOT_FOUND,
    );
  }

  const prepared = await prepareFields(lix, object_slug, fields);
  if (prepared.length === 0) {
    throw new AcrmError(
      "no fields provided (nothing to update)",
      ERR.INVALID_INPUT,
    );
  }

  const changed = await applyFields(lix, object_slug, record_id, prepared, source);

  return {
    updated: true,
    object_slug,
    record_id,
    values_changed: changed,
  };
}
