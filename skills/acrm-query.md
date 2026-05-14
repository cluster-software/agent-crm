---
description: Cheat-sheet for querying the .acrm workspace with `acrm execute`. Read this before writing any SQL against acrm. acrm uses an EAV schema — there is no `people` / `companies` / `transcripts` table.
---

The .acrm file does **not** have per-object SQL tables. Every record lives in
`acrm_record`; every attribute value lives in `acrm_value`. The object names
you see in the docs (`people`, `companies`, `deals`, `posts`, `transcripts`)
are values in the `object_slug` column — not tables.

```
❌ SELECT * FROM people                                  -- fails: no such table
✅ SELECT record_id FROM acrm_record WHERE object_slug='people'
```

## Tables

| table            | purpose                                                                       |
|------------------|-------------------------------------------------------------------------------|
| `acrm_record`    | one row per record. Columns: `object_slug`, `record_id`.                      |
| `acrm_value`     | one row per attribute value (current OR historical, see `active_until`).      |
| `acrm_attribute` | schema: which attributes exist on which object, type, multivalued, unique.    |
| `acrm_object`    | the list of registered objects (`people`, `companies`, …).                    |

### `acrm_value` columns worth knowing

- `id` — value-row PK. Use this for surgical updates (`UPDATE … WHERE id=$1`).
- `object_slug`, `record_id`, `attribute_slug` — the entity this value belongs to.
- `value_json` — the typed payload (e.g. `{"value":"Cluster"}` or `{"target_record_id":"…"}`).
- `normalized_key` — denormalized key for unique-keyed attrs (email_address, domain, url, text).
- `ref_object`, `ref_record_id` — for record-reference attrs, the indexed link target.
- `active_from`, `active_until` — versioning. **Always filter `active_until IS NULL` for current values.**
- `source`, `provenance_json` — where this value came from.

## SQL dialect: DataFusion

- Placeholders are `$1`, `$2`, … (`?` is rejected).
- Single statement per `acrm execute` call.
- No `sqlite_master` — use `information_schema.tables`, `information_schema.columns`.
- No `json_extract` — use lix UDFs:
  - `lix_json_get(value_json, 'key')` returns a JSON value.
  - `lix_json_get_text(value_json, 'key')` returns text.

## Common queries

Dump the EAV layout for the current workspace once at session start:

```sh
acrm execute --schema
```

Count records by object:

```sh
acrm execute "SELECT object_slug, COUNT(*) AS n FROM acrm_record GROUP BY object_slug"
```

Read every active field for one person:

```sh
acrm execute "
  SELECT attribute_slug, value_json, normalized_key, ref_record_id
  FROM   acrm_value
  WHERE  object_slug = 'people' AND record_id = \$1
         AND active_until IS NULL" '["<record_id>"]'
```

Find a person by email:

```sh
acrm execute "
  SELECT record_id
  FROM   acrm_value
  WHERE  object_slug = 'people' AND attribute_slug = 'email_addresses'
         AND normalized_key = \$1 AND active_until IS NULL
  LIMIT 1" '["alice@example.com"]'
```

List a person's transcripts (forward link from `people.associated_transcripts`):

```sh
acrm execute "
  SELECT ref_record_id AS transcript_id
  FROM   acrm_value
  WHERE  object_slug = 'people' AND record_id = \$1
         AND attribute_slug = 'associated_transcripts'
         AND active_until IS NULL" '["<person_record_id>"]'
```

Read a transcript's participants (and only those rows):

```sh
acrm execute "
  SELECT ref_record_id AS person_id
  FROM   acrm_value
  WHERE  object_slug = 'transcripts' AND record_id = \$1
         AND attribute_slug = 'participants'
         AND active_until IS NULL" '["<transcript_record_id>"]'
```

> Don't `SELECT *` from `acrm_value` without filtering by `attribute_slug` —
> a transcript row's `content` field alone can be tens of kilobytes.

## Deduping records (collapsing two rows that describe the same entity)

Don't hand-write merge SQL — use the first-class command:

```sh
acrm records dedupe people --keep <record_id> --discard <record_id> --dry-run
acrm records dedupe people --keep <record_id> --discard <record_id>
```

Works on any object (`people`, `companies`, `deals`, `posts`, `transcripts`).
Reassigns the discard's `acrm_value` rows to the keeper, rewrites every inbound
reference (including the embedded `target_record_id` in `value_json`), dedupes
multivalued attributes, applies a conflict policy on single-valued attributes
(`--prefer keep|discard|interactive`, default `keep`), and removes the discarded
`acrm_record` row.

> The verb is `dedupe`, not `merge` — `merge` in lix-land means version/branch
> merging (`mergeVersion`), which is a different operation.

## Mutating directly (rare)

Prefer the CLI's `acrm import …` and `acrm records dedupe …` commands — they
handle soft-delete (`active_until`), provenance, and EAV invariants. Hand-rolled
`INSERT`/`UPDATE` on `acrm_value` should be the last resort, and you should
read [the upsert helpers](https://github.com/cluster-software/agent-crm) once
before doing it.
