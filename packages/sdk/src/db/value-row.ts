import {
  normalizeUniqueKey,
  type AttributeType,
  type ValueJson,
} from "../domain/values.js";
import { nowIso } from "../lib/time.js";

export type ValueInsertInput = {
  object_slug: string;
  record_id: string;
  attribute_slug: string;
  attribute_type: AttributeType;
  value_json: ValueJson;
  source: string;
  provenance: Record<string, unknown>;
};

export type PreparedValueInsert = {
  id: string;
  object_slug: string;
  record_id: string;
  attribute_slug: string;
  value_json: string;
  active_from: string;
  normalized_key: string | null;
  ref_object: string | null;
  ref_record_id: string | null;
  source: string;
  provenance_json: string;
};

export function prepareValueInsert(
  id: string,
  args: ValueInsertInput,
): PreparedValueInsert {
  const normalized = normalizeUniqueKey(args.attribute_type, args.value_json);
  const ref =
    args.attribute_type === "record-reference" &&
    typeof args.value_json === "object" &&
    args.value_json !== null &&
    !Array.isArray(args.value_json)
      ? {
          ref_object: (args.value_json.target_object as string) ?? null,
          ref_record_id: (args.value_json.target_record_id as string) ?? null,
        }
      : { ref_object: null, ref_record_id: null };
  return {
    id,
    object_slug: args.object_slug,
    record_id: args.record_id,
    attribute_slug: args.attribute_slug,
    value_json: JSON.stringify(args.value_json),
    active_from: nowIso(),
    normalized_key: normalized,
    ref_object: ref.ref_object,
    ref_record_id: ref.ref_record_id,
    source: args.source,
    provenance_json: JSON.stringify(args.provenance),
  };
}
