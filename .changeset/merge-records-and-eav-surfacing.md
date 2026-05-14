---
"@agent-crm/cli": minor
---

Add `acrm merge` and surface the EAV schema in the CLI itself.

Background: merging two duplicate `people` records (created by an `acrm import linkedin` pass and an `acrm import transcript` pass with disjoint identifier sets) used to require hand-written SQL surgery against `acrm_record` + `acrm_value` — several introspection queries, two `UPDATE acrm_value` statements, one `DELETE FROM acrm_record`, and a `SELECT * FROM people` that errored because the EAV shape isn't a per-object table. RCA recommended a merge primitive + putting the EAV model in front of every code path an agent could reach for.

**`acrm merge <object> --keep <record_id> --discard <record_id>`** (new). First-class merge command. Reassigns every `acrm_value` row from the discard to the keeper, dedupes multivalued attributes by `normalized_key` (or `ref_record_id` for record-references), resolves single-valued conflicts via `--prefer keep | discard | interactive` (default `keep`), rewrites every inbound reference (both `ref_record_id` and the embedded `value_json.target_record_id`), and deletes the discarded `acrm_record` row. Supports `--dry-run` to print the plan without applying and `--json` (inherited) for machine output. Lix doesn't expose `BEGIN`/`COMMIT`, so the command is not a single SQL transaction — it validates the full plan before any mutation and is idempotent on re-run; documented in `--help`.

**`acrm execute --schema`** (new flag). Dumps the workspace's full EAV layout — objects, attributes per object, type, multivalued, unique, config_json — as JSON. Cheaper than four introspection queries for an agent loading the schema once at session start.

**EAV warnings in CLI help text and error hints.**

- `acrm --help` top-level description now opens with a one-paragraph warning that there is no `people` / `companies` / `transcripts` table — those are `object_slug` values on `acrm_record`, with fields stored as rows in `acrm_value`. Right next to the existing "Data model:" conceptual block.
- `acrm execute --help` gains an EAV-first section before the dialect notes: ❌/✅ examples (`SELECT * FROM people` vs `SELECT record_id FROM acrm_record WHERE object_slug='people'`), the three tables agents need to know (`acrm_record`, `acrm_value`, `acrm_attribute`), the pivot pattern for reading one record's fields, and the `active_until IS NULL` rule.
- `LIX_TABLE_NOT_FOUND` hint upgrade. When the missing table name matches a known `object_slug` (`people`, `companies`, `deals`, `posts`, `transcripts`), the hint becomes a copy-pasteable fix that names the exact mistake: ``` `people` is an object_slug, not a table. Try: `SELECT record_id FROM acrm_record WHERE object_slug='people'`. To read fields, pivot from acrm_value (filter active_until IS NULL). ``` This catches the exact mistake at the moment it happens, with the exact fix inline.

**`skills/acrm-query.md`** (new). EAV cheat-sheet for the postinstall skill bundle — auto-installed into Claude Code / Codex / Cursor via the existing `acrm skills` installer. Covers tables, common pivots (read all fields for one record, find a person by email, list a person's transcripts, read a transcript's participants), the DataFusion dialect rules, and points at `acrm merge` for the duplicate-record workflow.

Tests: 11 new unit tests cover merge planning (multivalued dedupe, single-valued conflict policies, inbound ref redirect with `value_json` rewrite, dry-run, validation) and the table-not-found hint upgrade.
