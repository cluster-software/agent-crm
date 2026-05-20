---
name: acrm-query
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

## Shell quoting (read first — the #1 footgun)

**Always single-quote the SQL** when it contains `$1`, `$2`, … placeholders. In
zsh/bash, double quotes let the shell expand `$N` to its own positional
parameters (empty in an interactive shell), so the SQL that reaches `acrm` has
bare gaps and the parser errors out with `LIX_PARSE_ERROR` at a random column.

```sh
❌ acrm execute "SELECT $1"  '["hi"]'    # zsh eats $1 → "SELECT "
✅ acrm execute 'SELECT $1'  '["hi"]'    # single quotes pass it through
✅ acrm execute "SELECT \$1" '["hi"]'    # or escape each $
```

The params argument is itself JSON, so single-quote it too. Inside, escape
inner double-quotes with `\"`:

```sh
acrm execute 'UPDATE acrm_value SET value_json = $1 WHERE id = $2' \
  '["{\"key\":\"value\"}","row-id"]'
```

Why no `$1`-free heredoc trick? `acrm execute` rejects `?` placeholders
(DataFusion limitation), so `$N` is mandatory whenever you bind params.

## Tables

| table            | purpose                                                                       |
|------------------|-------------------------------------------------------------------------------|
| `acrm_record`    | one row per record. Columns: `object_slug`, `record_id`.                      |
| `acrm_value`     | one row per attribute value (current OR historical, see `active_until`).      |
| `acrm_attribute` | schema: which attributes exist on which object, type, multivalued, unique.    |
| `acrm_object`    | the list of registered objects (`people`, `companies`, …).                    |

### `acrm_value` columns worth knowing

- `id` — value-row PK. Use this for surgical updates (`UPDATE … WHERE id=$1`).
  Lix-defaulted to `lix_uuid_v7()` if omitted on insert.
- `object_slug`, `record_id`, `attribute_slug` — the entity this value belongs to.
- `value_json` — the typed payload (e.g. `{"value":"Cluster"}` or `{"target_record_id":"…"}`).
- `normalized_key` — denormalized key for unique-keyed attrs (email_address, domain, url, text).
- `ref_object`, `ref_record_id` — for record-reference attrs, the indexed link target.
- `active_from`, `active_until` — versioning. `active_from` is Lix-defaulted to
  `lix_timestamp()` if omitted. **Always filter `active_until IS NULL` for current values.**
- `source`, `provenance_json` — where this value came from.

`attribute_type` is **not** a column on `acrm_value` — it lives on
`acrm_attribute`. JOIN when you need it:

```sql
SELECT v.attribute_slug, a.attribute_type, v.value_json
FROM   acrm_value v
JOIN   acrm_attribute a
       ON a.object_slug = v.object_slug AND a.attribute_slug = v.attribute_slug
WHERE  v.object_slug = 'people' AND v.record_id = $1
       AND v.active_until IS NULL;
```

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

## Custom schema (registering objects + attributes)

The five seeded objects (`people`, `companies`, `deals`, `posts`, `transcripts`)
are not the only ones you can have. When the user's domain doesn't fit (hiring
pipeline, fundraising, projects, …), register a custom object rather than
coercing data into `deals`:

```sh
# 1. register the object
acrm object create candidates

# 2. add fields (status options are first-class — no need to overload next_step)
acrm attribute add candidates.name --type personal-name
acrm attribute add candidates.email_addresses --type email-address \
    --multivalued --unique
acrm attribute add candidates.stage --type status \
    --option sourced --option screen --option onsite --option offer
acrm attribute add candidates.applied_for --type record-reference \
    --target-object deals

# 3. create records
acrm records create candidates \
    --field name="Daria Volkov" \
    --field stage=screen \
    --field email_addresses=daria@example.com
```

To extend a *built-in* enum (e.g. add a stage to `deals.stage`):

```sh
acrm attribute edit-options deals.stage add renewed
```

## value_json shape per attribute_type

`lix_json_get_text(value_json, 'value')` returns NULL on most non-text types
because they don't use a `value` key. Use the right key:

| attribute_type     | shape                                                            |
|--------------------|------------------------------------------------------------------|
| `text`, `url`      | `{"value": "<string>"}`                                          |
| `number`           | `{"value": <number>}`                                            |
| `date`             | `{"date": "<YYYY-MM-DD>"}`                                       |
| `timestamp`        | `{"timestamp": "<ISO-8601>"}`                                    |
| `personal-name`    | `{"full_name": ..., "first_name": ..., "last_name": ...}`        |
| `email-address`    | `{"email_address": "<lower>", "email_domain": "<lower>", ...}`   |
| `domain`           | `{"domain": "<lower>", "root_domain": "<lower>"}`                |
| `currency`         | `{"currency_value": <number>, "currency_code": "<code>"}`        |
| `status`, `select` | `{"id": "<option_id>", "title": "<display>"}`                    |
| `record-reference` | `{"target_object": "<slug>", "target_record_id": "<uuid>"}`      |

For `record-reference` attributes, prefer the indexed columns (`ref_object`,
`ref_record_id`) for joins/filters over digging into `value_json.target_record_id`.

## Mutating directly

The CLI wraps the common cases: use `acrm import …`, `acrm records create …`,
`acrm records dedupe …`, `acrm object create …`, `acrm attribute add …`, and
`acrm attribute edit-options …`. They handle soft-delete (`active_until`),
provenance, EAV invariants, and enum validation.

When you need something the CLI doesn't cover, writing directly to the EAV
tables via `acrm execute` is supported and expected — that's what the CLI
commands do internally. The `acrm_object`, `acrm_attribute`, `acrm_record`, and
`acrm_value` tables are stable surfaces. The minimal insert is:

```sql
INSERT INTO acrm_value (object_slug, record_id, attribute_slug, value_json)
VALUES ('people', 'person_1', 'name', '{"full_name":"Ada Lovelace"}');
```

`id` defaults to `lix_uuid_v7()` and `active_from` to `lix_timestamp()`. The
invariants `acrm_value` mutations must still maintain themselves: `active_until = NULL`
for current values (set the previous current row's `active_until` to NOW when
replacing a single-valued attr), the right `normalized_key` for unique-keyed
attribute types (`email-address`, `domain`, `url`, `text`), and
`ref_object` / `ref_record_id` for record-references.
