---
"@agent-crm/cli": patch
---

Fix `enrich-x-bio` skill: the documented INSERT templates referenced a
non-existent `attribute_type` column on `acrm_value`, so every enrichment
write failed with `LIX_COLUMN_NOT_FOUND` on first execution. Remove the
column (and its `'text'` / `'record-reference'` literals) from the three
INSERTs and add a hint pointing to `SELECT * FROM <table> LIMIT 1` as the
schema-inspection workaround now that `DESCRIBE` is unsupported.
