---
"@agent-crm/cli": minor
---

Custom schema commands: agents and humans can now register their own objects, attributes, and enum options without hand-rolling EAV INSERTs. Driven by an ax-eval that showed 10/10 cold agents coerce hiring pipelines into `deals` because no CLI verb exists for the custom-object path.

- `acrm object create <slug>` — register a new object (e.g. `candidates`, `tasks`, `accounts`) alongside the built-in five (`people` / `companies` / `deals` / `posts` / `transcripts`). Singular and plural display labels are derived from the slug (`candidates` → `Candidate` / `Candidates`), overridable with `--singular` / `--plural`.

- `acrm attribute add <object>.<slug> --type <type>` — add a field to any object (built-in or custom). Supports all 12 attribute types, plus `--multivalued`, `--unique`, `--option <id[:title]>` (repeatable, required for `status`/`select`), `--target-object` and `--inverse` for `record-reference`, and `--currency-code` for `currency`.

- `acrm attribute edit-options <object>.<slug> add|remove <option>` — extend (or trim) a `status`/`select` enum without writing raw SQL. Works on built-in objects too: `acrm attribute edit-options deals.stage add renewed`.

- `acrm records create <object> --field <slug>=<value>` — create a single record. Repeatable `--field` flag; record-reference values use `<target_object>:<target_record_id>`. Validation runs before any write — bad enum values, unknown attributes, or unknown objects fail loudly without leaving an orphan `record_id` behind.

- `acrm records update <object> <record_id> --field <slug>=<value>` — edit fields on an existing record. Single-valued attributes are replaced (use this to advance a candidate from `sourced` → `screen` without writing raw `UPDATE acrm_value` SQL); multivalued attributes get the new value added alongside existing ones (use `acrm records dedupe` to collapse if needed). Same validation guarantees as `create`.

Enum validation: `acrm import csv` and `acrm records create` / `update` now hard-error when a `status`/`select` value doesn't match a configured option. Pre-this-release silently coerced unknown values into `{title: raw}`, which round-tripped through the UI as a free-text option that couldn't be filtered with `WHERE id=...`. Error includes a copy-paste hint pointing at `acrm attribute edit-options`.

Docs: `acrm execute --help` and the `acrm-query` skill now document JSON value shapes per attribute type (the `lix_json_get_text(value_json, 'value')` returning NULL on status/currency/personal-name was the second-most-common ax-eval friction). The "hand-rolled mutation should be the last resort" guidance was removed — direct writes to `acrm_object` / `acrm_attribute` / `acrm_value` are supported and expected when the CLI doesn't cover a case.
