---
"@agent-crm/cli": minor
---

Make `acrm_value` writable with the obvious four-column INSERT (issue #51). The schema previously required `attribute_type` (already known from `acrm_attribute`) and `active_from` (mechanical bookkeeping), so the natural query failed with a validation error and new developers hit the wall on their first direct write.

- `acrm_value.attribute_type` is removed. The type lives on `acrm_attribute` — join when you need it (`acrm-query` skill has the canonical pattern). The two internal read sites that pulled `attribute_type` from `acrm_value` (the dedupe flow's `loadActiveValues` / `loadInboundRefs`) now JOIN to `acrm_attribute`.

- `acrm_value.active_from` is now Lix-defaulted to `lix_timestamp()`. Writers don't have to pass it. `id` was already defaulted to `lix_uuid_v7()`.

The naive insert from the issue now works:

```sql
INSERT INTO acrm_value (object_slug, record_id, attribute_slug, value_json)
VALUES ('people', 'person_1', 'name', '{"full_name":"Ada Lovelace"}');
```

`normalized_key` / `ref_object` / `ref_record_id` stay as nullable indexed columns on `acrm_value` — direct-SQL writers still populate them for unique-keyed attrs and record-references (documented in the `acrm-query` skill).
