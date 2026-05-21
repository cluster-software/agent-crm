# @agent-crm/cli

## 0.16.0

### Minor Changes

- 2e01271: Add `/acrm-onboarding` skill and `acrm import gmail` command.

  New users can now run `/acrm-onboarding` and pick a data source (Gmail / CSV /
  LinkedIn or X profile) to populate a fresh workspace. The Gmail path shells
  out to the [`gws` CLI](https://github.com/googleworkspace/cli), pulls People
  API `connections` plus auto-created `otherContacts` (every email
  correspondent Google has saved), and upserts them as `people` + `companies`
  deduped by email and email-domain — matching `acrm import csv` semantics.

  acrm ships with its own bundled Google OAuth Desktop client, so the end-user
  flow is just `npm install -g @googleworkspace/cli` + `acrm import gmail` →
  one browser pop-up to consent → done. No GCP project, no gcloud install, no
  Cloud Console clicks. Power users who prefer their own OAuth client can set
  `ACRM_GOOGLE_CLIENT_ID` + `ACRM_GOOGLE_CLIENT_SECRET` to override.

  - SDK: `importGoogleContacts(workspace, { contacts, default_country? })`
    accepts an iterable of `GoogleContact` and upserts via the existing dedup
    cascade. New `resolveGoogleClientCredentials()` + `buildClientSecretJson()`
    helpers expose the bundled OAuth client (with env-var override).
  - CLI: `acrm import gmail [--no-other-contacts] [--default-country <iso>]`.
    Auto-bootstraps `~/.config/gws/client_secret.json` on first run, then
    drives `gws auth login -s people` itself if not authed.

### Patch Changes

- Updated dependencies [2e01271]
  - @agent-crm/sdk@0.5.0

## 0.15.2

### Patch Changes

- 1c319a3: Fix `import-post` SKILL.md: the description contained `Phrasings:` mid-string,
  which YAML parses as a nested mapping key. Codex enforces YAML strictly and
  was skipping the skill with `mapping values are not allowed in this context`.
  Replace the colon with an em dash so the frontmatter parses everywhere.

## 0.15.1

### Patch Changes

- d1649c3: Fix Codex skill recognition: four bundled skills (`acrm-query`, `post-call`,
  `prep-call`, `setup-transcripts`) were missing the `name:` field in their
  SKILL.md frontmatter. Codex requires both `name` and `description` and
  silently skipped these skills at session start. Add `name:` to all four —
  existing installs re-sync on next `acrm skills install` / npm postinstall
  because the source file hashes changed.

## 0.15.0

### Minor Changes

- 527963a: `acrm import csv` now treats phone numbers as a first-class person identifier.
  Address-book exports (macOS Contacts, Google Contacts, iCloud) that carry
  phone-only rows used to be silently dropped — fixes #84, where 931 of 1112
  contacts in one user's import never landed.

  - Recognized headers: `phone | mobile | cell | telephone | tel`, with
    optional `_number` suffix, optional `_N` index, and optional `work_` /
    `personal_` / `home_` / `mobile_` / `cell_` / `primary_` / `business_` /
    `other_` prefix. Multiple numbers per column are split on `,` or `;`.
  - Dedup cascade is now: email → linkedin → twitter → **phone**. Phones are
    parsed to E.164 via `libphonenumber-js`, so `(415) 555-1234`,
    `1-415-555-1234`, and `+1 (415) 555-1234` all dedupe to `+14155551234`.
  - New `--default-country <iso>` flag on `acrm import csv` (defaults to
    `US`) controls how locally-formatted numbers are parsed. Numbers that
    already include a `+<dial-code>` prefix are parsed independent of the
    default. Pass `--default-country=GB` (etc.) when importing contacts
    from another locale.
  - New schema attribute `people.phone_numbers` (multivalued + unique,
    type `phone-number`). New workspaces get it via `acrm init`; existing
    `.acrm` files will pick it up the next time you create a new workspace.
  - The SDK gains a new `phone-number` `AttributeType`, a
    `normalizePhoneNumber(input, defaultCountry?)` helper backed by
    `libphonenumber-js/min`, and `phones` / `phone` fields on
    `PersonIdentifiers`. `resolvePersonByIdentifiers` / `normalizeIdentifiers`
    now accept `{ default_country }` so the cascade is shared between
    `acrm import csv` and `acrm import transcript`.

### Patch Changes

- Updated dependencies [527963a]
  - @agent-crm/sdk@0.4.0

## 0.14.1

### Patch Changes

- 08387d6: Add `homepage`, `repository`, and `bugs` fields to `package.json` so the npm page links back to the GitHub repo and tooling like `npm bugs` works.

## 0.14.0

### Minor Changes

- 5014031: Remove the built-in `acrm ui` command and its post-import auto-launch. The
  local-server UI shipped with the CLI is superseded by the standalone Electron
  app, so the CLI is headless-only now: `acrm import csv` no longer accepts
  `--port`, `--no-ui`, or `--no-open`, and no longer spawns a background UI
  server on success. The SDK's `ERR.UI` error code is dropped along with the
  command.

### Patch Changes

- Updated dependencies [5014031]
  - @agent-crm/sdk@0.3.0

## 0.13.5

### Patch Changes

- e877e34: Fix `enrich-x-bio` skill: the documented INSERT templates referenced a
  non-existent `attribute_type` column on `acrm_value`, so every enrichment
  write failed with `LIX_COLUMN_NOT_FOUND` on first execution. Remove the
  column (and its `'text'` / `'record-reference'` literals) from the three
  INSERTs and add a hint pointing to `SELECT * FROM <table> LIMIT 1` as the
  schema-inspection workaround now that `DESCRIBE` is unsupported.

## 0.13.4

### Patch Changes

- 4e0255d: Consolidate SDK workspace lifecycle around `Workspace.create()` and
  `Workspace.open()`, removing the functional lifecycle helpers from the public
  API. Update CLI initialization to use the canonical workspace API.
- Updated dependencies [4e0255d]
  - @agent-crm/sdk@0.2.0

## 0.13.3

### Patch Changes

- 03bf969: Update the npm package descriptions.
- Updated dependencies [03bf969]
  - @agent-crm/sdk@0.1.3

## 0.13.2

### Patch Changes

- Updated dependencies [99a3bbe]
  - @agent-crm/sdk@0.1.2

## 0.13.1

### Patch Changes

- d716d14: Verify the CI `NPM_TOKEN` has rights to publish both `@agent-crm/sdk` and
  `@agent-crm/cli` after the granular-token allowlist fix. Adds a SDK
  README and bumps both packages by a patch to exercise the full
  changesets → publish pipeline.
- Updated dependencies [d716d14]
  - @agent-crm/sdk@0.1.1

## 0.13.0

### Minor Changes

- bf2c0a8: Carve `@agent-crm/sdk` out of `@agent-crm/cli`. The repo is now an npm
  workspace with two published packages:

  - **`@agent-crm/sdk`** — programmatic API: `Workspace`, the per-operation
    functions (`importTranscript`, `importCsv`, `dedupeRecords`, …), the
    domain helpers (`encode`, `normalizeIdentifiers`, …), the integration
    adapters (Granola, Apify, MCP), and the EAV schemas. Takes structured
    inputs, returns structured results, never touches `process.argv` /
    `cwd` / `exit` / `stdout` / `stderr` / `stdin` / `env`.

  - **`@agent-crm/cli`** — the `acrm` command-line tool. Now a thin
    argv-and-output adapter on top of the SDK. Public command surface
    (flags, positional args, JSON output shape) is byte-identical to
    prior releases. Depends on `@agent-crm/sdk` for everything except
    commander wiring, stdout/stderr formatting, the local UI server
    (`acrm ui`), the OAuth callback flow (`acrm auth <provider>`), the
    CSV-import progress bar, and skills installation.

  Refs #64.

### Patch Changes

- Updated dependencies [bf2c0a8]
  - @agent-crm/sdk@0.1.0

## 0.12.0

### Minor Changes

- f001a3d: Make `acrm_value` writable with the obvious four-column INSERT (issue #51). The schema previously required `attribute_type` (already known from `acrm_attribute`) and `active_from` (mechanical bookkeeping), so the natural query failed with a validation error and new developers hit the wall on their first direct write.

  - `acrm_value.attribute_type` is removed. The type lives on `acrm_attribute` — join when you need it (`acrm-query` skill has the canonical pattern). The two internal read sites that pulled `attribute_type` from `acrm_value` (the dedupe flow's `loadActiveValues` / `loadInboundRefs`) now JOIN to `acrm_attribute`.

  - `acrm_value.active_from` is now Lix-defaulted to `lix_timestamp()`. Writers don't have to pass it. `id` was already defaulted to `lix_uuid_v7()`.

  The naive insert from the issue now works:

  ```sql
  INSERT INTO acrm_value (object_slug, record_id, attribute_slug, value_json)
  VALUES ('people', 'person_1', 'name', '{"full_name":"Ada Lovelace"}');
  ```

  `normalized_key` / `ref_object` / `ref_record_id` stay as nullable indexed columns on `acrm_value` — direct-SQL writers still populate them for unique-keyed attrs and record-references (documented in the `acrm-query` skill).

## 0.11.0

### Minor Changes

- 436d065: Custom schema commands: agents and humans can now register their own objects, attributes, and enum options without hand-rolling EAV INSERTs. Driven by an ax-eval that showed 10/10 cold agents coerce hiring pipelines into `deals` because no CLI verb exists for the custom-object path.

  - `acrm object create <slug>` — register a new object (e.g. `candidates`, `tasks`, `accounts`) alongside the built-in five (`people` / `companies` / `deals` / `posts` / `transcripts`). Singular and plural display labels are derived from the slug (`candidates` → `Candidate` / `Candidates`), overridable with `--singular` / `--plural`.

  - `acrm attribute add <object>.<slug> --type <type>` — add a field to any object (built-in or custom). Supports all 12 attribute types, plus `--multivalued`, `--unique`, `--option <id[:title]>` (repeatable, required for `status`/`select`), `--target-object` and `--inverse` for `record-reference`, and `--currency-code` for `currency`.

  - `acrm attribute edit-options <object>.<slug> add|remove <option>` — extend (or trim) a `status`/`select` enum without writing raw SQL. Works on built-in objects too: `acrm attribute edit-options deals.stage add renewed`.

  - `acrm records create <object> --field <slug>=<value>` — create a single record. Repeatable `--field` flag; record-reference values use `<target_object>:<target_record_id>`. Validation runs before any write — bad enum values, unknown attributes, or unknown objects fail loudly without leaving an orphan `record_id` behind.

  - `acrm records update <object> <record_id> --field <slug>=<value>` — edit fields on an existing record. Single-valued attributes are replaced (use this to advance a candidate from `sourced` → `screen` without writing raw `UPDATE acrm_value` SQL); multivalued attributes get the new value added alongside existing ones (use `acrm records dedupe` to collapse if needed). Same validation guarantees as `create`.

  Enum validation: `acrm import csv` and `acrm records create` / `update` now hard-error when a `status`/`select` value doesn't match a configured option. Pre-this-release silently coerced unknown values into `{title: raw}`, which round-tripped through the UI as a free-text option that couldn't be filtered with `WHERE id=...`. Error includes a copy-paste hint pointing at `acrm attribute edit-options`.

  Docs: `acrm execute --help` and the `acrm-query` skill now document JSON value shapes per attribute type (the `lix_json_get_text(value_json, 'value')` returning NULL on status/currency/personal-name was the second-most-common ax-eval friction). The "hand-rolled mutation should be the last resort" guidance was removed — direct writes to `acrm_object` / `acrm_attribute` / `acrm_value` are supported and expected when the CLI doesn't cover a case.

## Unreleased

### Minor Changes

- Custom schema: agents and humans can now register their own objects, attributes, and enum options without hand-rolling EAV INSERTs. Driven by an ax-eval that showed 10/10 cold agents coerce hiring pipelines into `deals` because no CLI verb exists for the custom-object path.

  - `acrm object create <slug>` — register a new object (e.g. `candidates`, `tasks`, `accounts`) alongside the built-in five.
  - `acrm attribute add <object>.<slug> --type <type>` — add a field. Supports `--multivalued`, `--unique`, `--option <id[:title]>` for status/select, `--target-object` and `--inverse` for record-reference, `--currency-code` for currency.
  - `acrm attribute edit-options <object>.<slug> add|remove <option>` — extend (or trim) a status/select enum. Works on built-in objects too: `acrm attribute edit-options deals.stage add renewed`.
  - `acrm records create <object> --field <slug>=<value>` — create a single record. Repeatable `--field` flag; record-reference values use `<target_object>:<target_record_id>`. Validation runs before any write — bad enum values, unknown attributes, or unknown objects fail loudly without leaving an orphan record_id behind.
  - `acrm records update <object> <record_id> --field <slug>=<value>` — edit fields on an existing record. Single-valued attributes are replaced (use this to advance a candidate from `sourced` → `screen` without writing raw `UPDATE acrm_value` SQL); multivalued attributes get the new value added alongside existing ones (use `acrm records dedupe` to collapse if needed). Same validation guarantees as `create`.

- Enum validation: `acrm import csv` and `acrm records create` now hard-error when a status/select value doesn't match a configured option. Pre-0.11 silently coerced unknown values into `{title: raw}`, which round-tripped through the UI as a free-text option that couldn't be filtered with `WHERE id=...`. Error includes a copy-paste hint pointing at `acrm attribute edit-options`.

- Docs: `acrm execute --help` and the `acrm-query` skill now document JSON value shapes per attribute type (the `lix_json_get_text(value_json, 'value')` returning NULL on status/currency/personal-name was the second-most-common ax-eval friction). The "hand-rolled mutation should be the last resort" guidance was removed — direct writes to `acrm_object` / `acrm_attribute` / `acrm_value` are supported and expected when the CLI doesn't cover a case.

## 0.10.0

### Minor Changes

- 438433c: Detect when the installed `acrm` CLI is outdated and prompt to update before continuing. Fixes #47.

  **Interactive TTY (humans).** When both stdin and stdout are TTYs, `acrm` shows a Codex-style block before running the command:

  ```
  ✨ Update available! 0.1.0 → 0.9.0

  Release notes: https://github.com/cluster-software/agent-crm/releases/latest

  › 1. Update now (runs `npm install -g @agent-crm/cli@latest`)
    2. Skip

  Press enter to continue
  ```

  Arrow keys (or number keys) move the cursor; Enter confirms. "Update now" runs `npm install -g @agent-crm/cli@latest` with inherited stdio and exits when it finishes, asking you to re-run your command with the new binary. "Skip" continues with your original command and is remembered for the cached latest version — once a _newer_ version is published, the prompt fires again.

  **Non-TTY (agents, pipes, CI).** Falls back to a one-line stderr warning so agents and pipelines see the update signal without anything to interact with:

  ```
  ⚠ A newer @agent-crm/cli is available: 0.9.0 (you are using 0.1.0).
    Run: npm install -g @agent-crm/cli@latest
  ```

  This was the original ask in #47 — agents reading `acrm --help` need an explicit, parseable instruction to update before initializing a workspace.

  **How the version check works.** On every CLI startup, `acrm` reads `~/.config/acrm/update-check.json` (honors `ACRM_CONFIG_DIR`). If the cache shows a newer published version, the prompt or warning fires. If the cache is missing or older than 24h, a detached, unref'd worker is spawned that hits `registry.npmjs.org/@agent-crm/cli/latest` and rewrites the cache — the current command returns immediately and the _next_ invocation sees the fresh result. Same pattern npm itself uses.

  **Output stays clean.** All update-check output goes to **stderr**, never stdout. `acrm execute "..." --json | jq .` parses normally even when a warning is firing.

  **Opt-outs.** Set `ACRM_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1`, or `CI=true` to suppress entirely. Dev/pre-release versions (anything with a `-` suffix) are skipped automatically.

  **No new dependencies.** ~250 lines of stdlib (`node:fs`, `node:child_process`, `node:readline`), including a small numeric semver comparator so `0.10.0 > 0.9.0` works correctly.

## 0.9.0

### Minor Changes

- c4d1874: Show imported posts on the person detail page (`acrm ui` → `/people/:id`) alongside transcripts.

  **Toggle.** The person page now has a Transcripts / Posts segmented toggle below the contact section, each tab showing its item count. Transcripts remain the default view so existing behavior is preserved.

  **Native embeds, not snippets.** Posts render as actual previews, not text rows. X posts use the official `platform.twitter.com/widgets.js` blockquote with `data-theme="dark"` so they sit naturally on the dark UI; LinkedIn posts use the official `linkedin.com/embed/feed/update/<urn>` iframe wrapped in a light card. Clicks inside an embed open the original post on x.com / linkedin.com in a new tab via the embed's own behavior — there is no separate post detail route.

  **Tab-switch widget refresh.** The X widget skips blockquotes that were processed while their container was `display:none`, so switching to the Posts pane re-invokes `twttr.widgets.load(...)` on the now-visible pane to render any tweets that didn't materialize on the first pass.

  **Date label fix.** `dateGroupLabel` now parses bare `YYYY-MM-DD` strings as local dates. Previously `new Date("2026-05-14")` produced UTC midnight, so in CST (UTC−6) a post dated today read as "Yesterday". Transcripts were unaffected because `started_at` includes a timezone.

## 0.8.0

### Minor Changes

- 5c25c32: Add a transcript detail page (`acrm ui` → `/transcripts/:id`) reachable from the timeline on a person's detail page.

  **Layout** — inspired by Granola. Title in serif, pill row with date (`Today` / `Yesterday` / `Mon, May 4`) and participants, then a Summary / Transcript toggle, then the content pane. Both panes are server-rendered; the toggle is a tiny inline script so switching is instant.

  **Summary view — markdown rendering.** Summaries from Granola / manual paste arrive as markdown, so the page now renders them as HTML instead of dumping `### Recovery & Current Work` as literal text. Covers headings (`#`..`######`, mapped to `h2`/`h3`/`h4`), unordered and ordered lists with indent-based nesting, inline bold / italic / code, and paragraphs. Lists produce well-formed nested HTML (`<ul><li>…<ul>…</ul></li></ul>`) so deeper bullets visually indent the way you'd expect.

  **Transcript view — speaker turns.** Raw transcripts often arrive as one wall of text with speaker tags inlined (`"…hear you.  Them: Very fast.  Me: Got it."`). The page now splits the content into one block per speaker turn. Each turn renders as a small speaker label above the utterance. Detection allows any whitespace between a sentence terminator and the next speaker tag (Granola's two-space convention, single-space, tabs, blank lines), and requires either start-of-text, a newline, or a `.!?` sentence boundary before the tag — so words like "Yeah." inside an utterance don't get mistaken for a turn break. If no speaker tags are detected, the content falls back to a `pre-wrap` block so existing line breaks survive.

  **Back button.** A small pill at the top of the transcript page returns the user to the person they came from. The timeline link on the person detail page now passes `?back=/people/:id`; the transcript route reads it (validating it's a same-site path, no `//`-prefixed URLs, to prevent open redirect) and defaults to `/people` if missing. The pill mirrors the visual style of the date/participants pills with a chevron + person glyph.

## 0.7.0

### Minor Changes

- 0744003: Fix `acrm ui` Deals page, add a clickable Person detail view, and stop the `acrm execute` shell-quoting footgun at the source.

  **Deals page (CLU-280).** `/deals` rendered "No deals yet" even when the count badge showed a non-zero number, because `renderDealsPage` had no list query — only the count query existed. Added `loadDeals` (joins `acrm_record` with `acrm_value` rows for `name`, `stage`, `value`, `close_date`, `next_step`, and `associated_company` via `ref_record_id`) and a real table renderer; the empty state now only shows when there are zero deals.

  **People page columns.** Added Email (first value from the multivalued `email_addresses`) and X (`twitter_url`) columns next to Role / Company / LinkedIn, matching the issue request to surface those identifiers directly in the list.

  **Companies "Type" column.** The header read "Type" but the cell rendered `description` — fixed by renaming the header to "Description". (The schema has no `type` attribute on companies.)

  **Person detail page (`/people/:id`).** Inspired by Granola's contact view. Each row in the People table is now clickable (real `<a>` on the name for keyboard / cmd-click, plus a single delegated row-click handler that ignores inner links so the inline `mailto:` / linkedin / x cells keep working). The detail page has a hero (avatar + Inter-rendered name), contact rows with mail / LinkedIn / X icons, and a reverse-chronological timeline of associated transcripts grouped by `Today` / `Yesterday` / `Thu, Apr 30` (year is appended for older entries). Transcript subtitles list other participants (`"Enrique"` or `"Shawn, Samuel & 3 others"`). Driven by `loadTranscriptsForPerson`, which queries `acrm_value` where `attribute_slug='participants' AND ref_record_id=$1`, joins each transcript's `title` + `started_at`, and runs a second query for the other participants' names.

  **`acrm execute` shell-quoting guardrail.** The recurring symptom: `acrm execute "UPDATE … WHERE id = $1" '[...]'` failed with `LIX_PARSE_ERROR at column 30` because zsh/bash had already expanded `$1` to the shell's (empty) first positional arg before the CLI even saw it. Three layers now prevent it:

  - **Runtime detection.** If `params` were passed but the SQL contains zero `$N` placeholders, `acrm execute` fails fast with a directive that names the cause and shows the single-quoted fix, rather than surfacing the misleading DataFusion parse error.
  - **`--help` text.** A new "SHELL QUOTING (read this first — it's the #1 footgun)" block sits above the SQL-dialect notes with ❌/✅ examples and a JSON-inside-single-quotes example. The one-liner description now opens with `SHELL: SINGLE-QUOTE the SQL whenever it contains $1/$2/...`.
  - **Skill cheat-sheet.** `skills/acrm-query.md` — the file Claude Code (and Codex / Cursor via the installer) reads _before_ writing SQL — gains a "Shell quoting" section near the top, so most agents avoid the mistake without ever needing the runtime guard.

## 0.6.0

### Minor Changes

- aeecf6d: Rename `acrm merge <object>` → `acrm records dedupe <object>`.

  Two reasons for the rename:

  - **Avoid collision with lix's "merge" terminology.** lix's `mergeVersion` / `mergeVersionPreview` already mean "merge two branches / versions of the workspace" — a different operation from collapsing two duplicate rows. Having both verbs alive on the same surface was going to confuse docs and chat ("merge the records on this branch and then merge the branch").
  - **Open a namespace for record-level operations.** Putting `records` at the front leaves room for the obvious siblings (`acrm records archive`, `acrm records restore`, `acrm records show <id>`, `acrm records list <object>`) without re-litigating the top-level command surface each time. Mirrors how `acrm import <source>` and `acrm auth <provider>` already group by capability.

  Old:

  ```sh
  acrm merge people --keep <id> --discard <id>
  acrm merge people --keep <id> --discard <id> --dry-run --prefer discard
  ```

  New:

  ```sh
  acrm records dedupe people --keep <id> --discard <id>
  acrm records dedupe people --keep <id> --discard <id> --dry-run --prefer discard
  acrm records dedupe companies --keep <id> --discard <id>
  ```

  Behavior is unchanged — all flags (`--keep`, `--discard`, `--prefer`, `--dry-run`) and the JSON result shape are identical. The implementation file moved to `src/commands/records.ts`; the programmatic export renamed `mergeRecords` → `dedupeRecords` (relevant only if you import it from outside the CLI).

  `skills/acrm-query.md` updated to use the new command and to call out the verb choice explicitly so agents don't try to use `acrm merge` and then guess at SQL surgery.

  **This is a breaking change for the CLI surface** — there is no shim under the old name. The merge command shipped in the previous release; anything wired against it (skills, scripts, CI) needs to switch to `acrm records dedupe`.

## 0.5.0

### Minor Changes

- 258349e: Add `acrm merge` and surface the EAV schema in the CLI itself.

  Background: merging two duplicate `people` records (created by an `acrm import linkedin` pass and an `acrm import transcript` pass with disjoint identifier sets) used to require hand-written SQL surgery against `acrm_record` + `acrm_value` — several introspection queries, two `UPDATE acrm_value` statements, one `DELETE FROM acrm_record`, and a `SELECT * FROM people` that errored because the EAV shape isn't a per-object table. RCA recommended a merge primitive + putting the EAV model in front of every code path an agent could reach for.

  **`acrm merge <object> --keep <record_id> --discard <record_id>`** (new). First-class merge command. Reassigns every `acrm_value` row from the discard to the keeper, dedupes multivalued attributes by `normalized_key` (or `ref_record_id` for record-references), resolves single-valued conflicts via `--prefer keep | discard | interactive` (default `keep`), rewrites every inbound reference (both `ref_record_id` and the embedded `value_json.target_record_id`), and deletes the discarded `acrm_record` row. Supports `--dry-run` to print the plan without applying and `--json` (inherited) for machine output. Lix doesn't expose `BEGIN`/`COMMIT`, so the command is not a single SQL transaction — it validates the full plan before any mutation and is idempotent on re-run; documented in `--help`.

  **`acrm execute --schema`** (new flag). Dumps the workspace's full EAV layout — objects, attributes per object, type, multivalued, unique, config_json — as JSON. Cheaper than four introspection queries for an agent loading the schema once at session start.

  **EAV warnings in CLI help text and error hints.**

  - `acrm --help` top-level description now opens with a one-paragraph warning that there is no `people` / `companies` / `transcripts` table — those are `object_slug` values on `acrm_record`, with fields stored as rows in `acrm_value`. Right next to the existing "Data model:" conceptual block.
  - `acrm execute --help` gains an EAV-first section before the dialect notes: ❌/✅ examples (`SELECT * FROM people` vs `SELECT record_id FROM acrm_record WHERE object_slug='people'`), the three tables agents need to know (`acrm_record`, `acrm_value`, `acrm_attribute`), the pivot pattern for reading one record's fields, and the `active_until IS NULL` rule.
  - `LIX_TABLE_NOT_FOUND` hint upgrade. When the missing table name matches a known `object_slug` (`people`, `companies`, `deals`, `posts`, `transcripts`), the hint becomes a copy-pasteable fix that names the exact mistake: `` `people` is an object_slug, not a table. Try: `SELECT record_id FROM acrm_record WHERE object_slug='people'`. To read fields, pivot from acrm_value (filter active_until IS NULL). `` This catches the exact mistake at the moment it happens, with the exact fix inline.

  **`skills/acrm-query.md`** (new). EAV cheat-sheet for the postinstall skill bundle — auto-installed into Claude Code / Codex / Cursor via the existing `acrm skills` installer. Covers tables, common pivots (read all fields for one record, find a person by email, list a person's transcripts, read a transcript's participants), the DataFusion dialect rules, and points at `acrm merge` for the duplicate-record workflow.

  Tests: 11 new unit tests cover merge planning (multivalued dedupe, single-valued conflict policies, inbound ref redirect with `value_json` rewrite, dry-run, validation) and the table-not-found hint upgrade.

## 0.4.3

### Patch Changes

- b4576f2: Fix drift in `/setup-transcripts` and `/transcript-provider-granola` after `acrm auth granola` and the fast-path transcript fetch landed.

  Both skills predated the 0.4.1 split that introduced a CLI-side OAuth flow (`acrm auth granola`, token at `~/.config/acrm/granola.json`) on top of the existing Claude Code MCP registration. The granola provider now touches **two independent auth surfaces** — MCP for `mcp__granola__list_meetings` (meeting discovery in the model session) and the CLI for `acrm import transcript --from granola` (transcript fetch outside the model) — and the skills modeled only the first. End state: `/setup-transcripts` would report Granola "connected" when the CLI token was missing, and `/post-call` step 2 would then crash with "no cached Granola credentials found".

  **`skills/transcript-provider-granola.md`.**

  - Header now spells out both auth surfaces and notes the token stores are independent.
  - **Detect** probes both surfaces and returns a _composite_ state (worst of the two). Tool-symbol absent → `not_installed`; either surface unauthenticated → `unauthenticated`; both connected → `connected`. CLI surface is checked via `test -f "${ACRM_CONFIG_DIR:-$HOME/.config/acrm}/granola.json"`. The adapter is now required to name _which_ surface is failing when surfacing state.
  - **Connect** split into `A. MCP surface` (in-session `mcp__granola__authenticate` → `mcp__granola__complete_authentication`) and `B. CLI surface` (`! acrm auth granola` from the user's own shell — the `!` prefix is load-bearing because Claude Code's bash tool buffers stdout/stderr and would hide the URL while the command blocks on the OAuth callback, per the 0.4.2 changelog). Captures DCR-is-automatic, token location, mode 0600, and the `--token` escape hatch.
  - **Fetch** rewritten around the fast path: the model resolves a `meeting_id` UUID and hands it to `acrm import transcript --from granola <meeting-id>`. Explicit "don't fetch transcript bytes inside the model" call-out, with the 4 min → sub-5s reason from the 0.4.1 changelog. Prompt-injection hygiene note reframed around the summary (the only thing the model now sees) instead of raw transcript bytes.
  - **Map to canonical** reframed as documentation of what the CLI emits internally (rather than what the model builds). Updated to reflect 0.4.0/0.4.1 behavior: multi-identifier participants (`email` / `linkedin_url` / `twitter_url`), always-use-provider-summary (no `--summary-from`), backfill + auto-create on resolve.

  **`skills/setup-transcripts.md`.**

  - Status menu now shows the four real Granola states (not installed / MCP-only / CLI-only / both) and the prose tells the composing skill to name which surface needs work when state is not `connected`.
  - Step 3 recovery for Granola spells out both Connect sub-flows with the `!` prefix rationale.

  No code changes. Skills-only.

## 0.4.2

### Patch Changes

- d1460c3: Fix `acrm auth granola` — Dynamic Client Registration + auto-open browser.

  Two bugs were stacking on top of each other.

  **Bug 1: hardcoded `client_id` was never registered with Granola.** The provider config hardcoded `client_id=acrm-cli`, but Granola's MCP OAuth server requires RFC 7591 Dynamic Client Registration (advertised via `registration_endpoint` in the discovery doc). The authorize URL returned `application_not_found` and the flow died before the user could even consent.

  The auth flow now POSTs to the discovery doc's `registration_endpoint` (with the actual loopback `redirect_uri` for this run) whenever the provider didn't supply a static `clientId`, gets back a fresh `client_id`, and uses it for the authorize + token-exchange steps. The registered `client_id` (and `client_secret`, if any) is persisted alongside the token in `~/.config/acrm/<provider>.json` so future refresh-token exchanges reuse the same client identity.

  The provider config now treats `clientId` as optional. `ACRM_GRANOLA_CLIENT_ID` still overrides DCR if you have a pre-registered public client. For every other provider, leaving `clientId` unset opts into DCR automatically — adapters with no `registration_endpoint` get a clear error pointing at the env var or `--token` escape hatch.

  **Bug 2: `! acrm auth granola` from inside Claude Code never showed the URL.** Claude Code's bash tool buffers stdout/stderr until the command exits. The auth command blocks indefinitely on the OAuth callback, so the URL never reached the screen and the user was stuck. Fixed by auto-opening the system browser (`open` / `xdg-open` / `start`) right after building the authorize URL. The URL is still printed (to stderr) as a fallback for headless environments.

  **Touched files.** `src/commands/auth.ts` (DCR call site, `registerClient()` helper, browser auto-open), `src/integrations/provider.ts` (`clientId` made optional, comment updated), `src/integrations/granola.ts` (drop the bogus `acrm-cli` default), `src/lib/token-cache.ts` (`CachedToken` carries `client_id` / `client_secret` / `registration_endpoint`).

## 0.4.1

### Patch Changes

- 98740be: Fast transcript import — keep transcript bytes off the LLM path.

  `/post-call` used to take ~4 minutes per Granola import because the LLM re-emitted the 39 KB transcript verbatim into a heredoc to build the canonical JSON. The CLI itself ran in ~1s; the rest was tokens. Bytes flowed _through the model as output tokens_. That's the bug.

  **New CLI surface.** `acrm import transcript --from <provider> <meeting-id>` fetches the transcript + summary + participants directly from the provider and writes in one shot. Granola is the only adapter today; the `--file` and stdin paths remain unchanged for anything without a native adapter.

  ```sh
  acrm import transcript --from granola 0c8c3f6e-...
  acrm import transcript --file ./transcript.json
  ```

  **`acrm auth granola`.** OAuth 2.0 + PKCE with discovery via `${endpoint}/.well-known/oauth-authorization-server`. Opens a local-loopback callback server, exchanges the code, caches the token at `~/.config/acrm/granola.json` (mode 0600). Override the cache dir via `ACRM_CONFIG_DIR`. Escape hatch: `acrm auth granola --token <token>` skips the browser flow when the user already has a token in hand.

  **Auto-create unknown participants.** When a participant carries at least one identifier (email / LinkedIn URL / Twitter URL) but no `people` record matches, the CLI now creates the record on the spot and links it as a resolved participant with `matched_by: "created"` and `created: true`. Mirrors the behavior of `acrm import linkedin`, which already auto-creates companies. Closes the "Enrique unresolved" failure mode from the spec.

  **Always use the provider's summary.** No `--summary-from` flag. If the user wants a different summary, they edit after the fact via `acrm execute`.

  **Updated `/post-call` skill.** Three steps: list meetings via MCP, pick the UUID, run `acrm import transcript --from granola <uuid>`. No transcript bytes through the model. Sub-5s end-to-end.

  **Test suite.** Added:

  - `src/lib/token-cache.test.ts` — round-trip, 0600 mode, ACRM_CONFIG_DIR override, expiry helpers.
  - `src/lib/oauth-pkce.test.ts` — verifier/challenge correctness against SHA-256, base64url charset, authorization-URL parameter encoding, scope omission, query-string preservation on the auth endpoint.
  - `src/integrations/mcp-http-client.test.ts` — JSON-RPC envelope shape, Bearer header, 401 → friendly hint, JSON-RPC error surfacing, SSE/streamable-HTTP body parsing, tool-result unwrapping.
  - `src/integrations/granola.test.ts` — transcript content extraction across shapes (`content`/`transcript`/`text`/nested), case-insensitive meeting-id match, attendees fallback, single-meeting-object shape, NOT_FOUND on miss, end-to-end fetch with mocked HTTP that builds canonical TranscriptPayload (including duration derived from start/end).
  - `src/commands/import-transcript.autocreate.test.ts` — auto-create from email, from LinkedIn alone, with all three identifiers, bidirectional link to the new record, idempotent re-import (no duplicate person on second pass).

  69 tests across 8 files, all green.

  **Out of scope (intentionally).** `--latest`/`--match`/`--since` (meeting discovery stays in the skill), `--link`/`--no-create-people` (auto-create is the default, no flag), `--force`/`--dry-run` (dedup by `source_id` is enough), reading the MCP server's token store (`~/.config/acrm/<provider>.json` is the only token location), exit-code taxonomy (one non-zero is enough).

## 0.4.0

### Minor Changes

- fbfc893: Resolve transcript participants by any of email / LinkedIn URL / Twitter URL, with backfill of missing identifiers.

  `acrm import transcript` used to require an `email` on every participant and resolved them with a single lookup against `people.email_addresses`. A meeting attendee whose `people` record carried only a LinkedIn URL (or whose record had a different email than what the meeting provider supplied) landed in `unresolved` even though the workspace held a unique identifier that unambiguously matched them. The CSV import path already did the right thing — email → linkedin → twitter cascade — but the cascade lived inline and the transcript path never picked it up.

  **Shared resolver.** New `src/domain/resolve-person.ts` exposes `resolvePersonByIdentifiers(lookup, ids)` running the canonical email → linkedin → twitter cascade. Both `acrm import csv` and `acrm import transcript` now funnel through this helper. The next identifier added (phone, handle, …) lands in one place.

  **Multi-identifier participants.** The canonical transcript JSON now accepts `{ email?, linkedin_url?, twitter_url? }` per participant, with at least one required. Email-only payloads keep working — pure superset. The CLI's `--help` and `docs/transcript-provider-protocol.md` describe the new shape; the `transcript-provider-granola` and `transcript-provider-manual` adapter skills pass identifiers through instead of forcing every attendee into an email-shaped slot.

  **Backfill on match.** When a participant resolves by LinkedIn/Twitter and the payload also carried an email (or vice versa) that the matched record didn't have, the CLI writes the missing identifier onto the record so the next import resolves directly. Single-value attributes (`linkedin_url`, `twitter_url`) are only filled when currently empty — curated values are never clobbered. Multi-value `email_addresses` dedupes on the normalized key. The result JSON's `resolved[].backfilled[]` lists which identifiers were written.

  **Better `unresolved` shape.** `unresolved[]` now carries `identifiers` (the normalized inputs that were probed), `tried` (which attribute indexes were hit), and `reason` of either `person_not_found` (at least one identifier was tried but missed) or `no_identifier_provided` (every supplied identifier normalized to empty). Self-debugging from the JSON output alone.

  **Test suite.** Added `src/domain/resolve-person.test.ts` (pure unit tests on normalization + cascade priority + skipped-when-null branches) and `src/commands/import-transcript.test.ts` (integration tests against an in-memory workspace covering email match, LinkedIn match, Twitter match, email-priority-over-linkedin, backfill of missing email, backfill of missing LinkedIn, no-clobber of curated LinkedIn, unresolved with `tried[]`/`reason`, idempotent re-import, malformed/empty-identifier rejection). 32 tests across the suite, all green.

## 0.3.3

### Patch Changes

- dc67212: Fix two drift defects in the `/post-call` skill.

  **1. DataFusion placeholder syntax.** Step 1's person-lookup SQL used SQLite-style `?` placeholders, which `acrm execute` rejects with `LIX_PARSE_ERROR: unsupported SQL parameter placeholder '?'`. Switched to DataFusion's numbered `$1` placeholders, escaped as `\$1` inside double-quoted shell strings so the shell doesn't expand them before `acrm` sees them. Added a one-line note pointing future editors at the dialect.

  **2. Stale customer-discovery template.** Step 4 forced every transcript through a fixed schema (`problem`, `current_workaround`, `frequency`, `would_pay`, `questions_asked`, `notes`) carried over from an earlier project, then composed those into a structured `summary` block. The agent-crm `transcripts` schema treats `summary` as an opaque text blob — no such fields exist — so the template produced nonsense on peer-to-peer / non-discovery meetings (e.g. "Would pay: blank — Luis is building, not buying"). Replaced step 4 with a short free-form prose summary (prefer the adapter's own summary when present, e.g. Granola's). Updated step 5's confirmation preview and step 6's JSON example to match.

  Both fixes applied to `skills/post-call.md` (the canonical copy that ships via the postinstall hook).

## 0.3.2

### Patch Changes

- d8f7c95: Fix `/post-call` silently falling back to manual when Granola's MCP server isn't registered with Claude Code.

  The Granola adapter's Detect/Connect protocol previously conflated two distinct failure modes — "MCP server not registered with the harness" and "MCP server registered but unauthenticated" — into a single "not connected" bucket. When the `mcp__granola__*` tool symbols didn't exist in the session at all, `/post-call` treated it the same as expired auth and dropped through to the manual adapter, never telling the user the one thing that would actually fix it: run `claude mcp add --transport http granola https://mcp.granola.ai/mcp` and restart Claude Code.

  **Three-state Detect contract.** `transcript-provider-*` adapters now report one of `connected`, `unauthenticated`, or `not_installed`. The new `not_installed` state has its own recovery section (`## Install`) that surfaces the exact shell command and stops the flow instead of degrading silently.

  **Updated files:**

  - `skills/transcript-provider-granola.md` — Detect now branches on tool-symbol availability; new `Install` section.
  - `skills/post-call.md` — step 2 routes on the three states; step 3 distinguishes `Install` from `Connect` recovery.
  - `skills/setup-transcripts.md` — menu and connect loop honor all three states.
  - `docs/transcript-provider-protocol.md` — adapter contract documents the three-state Detect plus the new `Install` section, so future `transcript-provider-*` adapters follow the same shape.

  Silent fallback to manual now only happens when no native adapter is installed at all, or when the user explicitly opts in ("just use manual for this one").

## 0.3.1

### Patch Changes

- 1dd0c3e: Fix `npm install -g @agent-crm/cli` not actually installing skills on a fresh install. The postinstall bootstrap (`postinstall.cjs`) was resolving the installer at `<pkg>/../dist/scripts/install-skills.js` — one level too high — so the `existsSync` guard always returned false and the script silently no-op'd. Result: skills weren't written to `~/.claude/skills/`, `~/.codex/skills/`, or `~/.cursor/skills/`, and `~/.acrm/skills.lock.json` was never created. Manual recovery via `acrm skills install` worked as a workaround. Fixed by correcting the path; the `acrm skills install` CLI command was unaffected because it resolves the source from `dist/commands/skills.js`, which has the right relative depth.

## 0.3.0

### Minor Changes

- 6079efa: Ship bundled skills to Claude Code, Codex, and Cursor on `npm install`.

  **Automatic multi-agent skill installation.** `npm install -g @agent-crm/cli` (and every `npm update`) now writes every acrm skill into each installed AI agent's user-scoped skills directory via an `postinstall` hook:

  - Claude Code: `~/.claude/skills/<name>/SKILL.md`
  - Codex: `~/.codex/skills/<name>/SKILL.md`
  - Cursor: `~/.cursor/skills/<name>/SKILL.md`

  Idempotent (hash-gated drift detection), error-tolerant (never aborts `npm install`), and only ever touches paths recorded in its lockfile at `~/.acrm/skills.lock.json`.

  **New `acrm skills` command** for manual control:

  - `acrm skills install [--agents <list>]` — re-sync (also the fallback for `--ignore-scripts` installs)
  - `acrm skills list` — show what's installed where
  - `acrm skills remove` — uninstall every acrm skill from every agent

  **Transcript providers promoted to first-class skills.** Files that used to live in `.claude/transcript-providers/` now ship as regular skills following the `transcript-provider-<vendor>` naming convention (`transcript-provider-granola`, `transcript-provider-manual`). Same agent-readable contract (Detect / Connect / Fetch / Map-to-canonical), same composition by `/post-call` and `/setup-transcripts` — they just ship through the standard skill mechanism now. Adding a new provider (Otter, Fireflies, Fathom, etc.) is a one-file operation: drop `transcript-provider-<vendor>.md` into `skills/` following the contract in `docs/transcript-provider-protocol.md`.

  **Generalized `skills/` directory** at the repo root is the new canonical source (moved from `.claude/skills/`). Agent-agnostic location, ships cleanly in the tarball, one source of truth for all three agents.

  The per-agent directory conventions are ported from `vercel-labs/skills@1.5.6`; the installer itself is bundled inside the CLI (no runtime dependency on `npx skills`) so installs work offline and never fetch a remote manifest.

## 0.2.0

### Minor Changes

- 8671074: Add a `transcripts` object to the data model and a provider-agnostic ingestion path.

  **New top-level `transcripts` object** in `acrm init`, alongside `people`, `companies`, `deals`, `posts`. Attributes: `title`, `started_at`, `ended_at`, `duration_seconds`, `source` (status: granola/zoom/meet/teams/manual/other), `source_id` (unique, used for dedup), `summary`, `content`, `participants` (multi-valued record-reference → people). Bidirectional inverse `people.associated_transcripts`. Field names mirror Attio's beta Meetings API.

  **`acrm import transcript`** command, modeled on `acrm import post`. Reads canonical JSON from stdin or `--file`:

  ```json
  {
    "source": "granola",
    "source_id": "<provider-meeting-id>",
    "title": "...",
    "started_at": "ISO-8601",
    "ended_at": "ISO-8601",
    "duration_seconds": 1800,
    "summary": "...",
    "content": "<raw transcript>",
    "participants": [{ "email": "..." }]
  }
  ```

  Resolves each participant against `people.email_addresses`; unknown emails are reported in an `unresolved` list (skip-but-warn). Dedups the transcript record by `source_id` so re-imports are idempotent. Writes both sides of the `participants` ↔ `associated_transcripts` link.

  **Provider-agnostic transcript ingestion** via adapter files in `.claude/transcript-providers/`. Each adapter exposes a `Detect` / `Connect` / `Fetch` / `Canonical source slug` contract. Ships with `granola.md` (MCP + OAuth) and `manual.md` (paste/file fallback). To add Otter, Fireflies, Fathom, Read.ai, Circleback, Zoom, etc., drop a new adapter file — no code or skill changes.

  **New skills**:

  - `setup-transcripts` — onboarding for transcript providers; scans the adapter dir, shows a menu, dispatches per-provider connect flow.
  - `post-call` — rewritten to be provider-agnostic. Detects connected adapters, dispatches to the right one, builds canonical JSON, pipes to `acrm import transcript`. Lazy OAuth fallback baked in. Drops the old `last_call` text attribute and raw-SQL writes.

  **CLI updates**: top-level `acrm --help` lists `transcripts` in the data model and `acrm import transcript` in the typical flow. `acrm init` "Next steps" hint surfaces `/setup-transcripts` as an optional onboarding step.

## 0.1.0

### Minor Changes

- 47c2733: Single-profile imports, post imports, and CSV reliability fixes since 0.0.7:

  **Import a person from a LinkedIn or X profile URL**

  - `acrm import linkedin <url-or-slug>` fetches a LinkedIn profile via Apify and upserts the person (deduped by `linkedin_url`) plus their current employer as a company.
  - `acrm import x <handle-or-url>` fetches an X/Twitter profile and upserts the person (deduped by `twitter_url`, normalized to `x.com/<handle>`). When the bio contains role/company info that's missing from the person record, returns a `needs_enrichment` payload that the new `enrich-x-bio` skill consumes to fill in `job_title` and `company`.
  - Apify responses are cached under `.cache/{linkedin,x}/` with a 14-day TTL. `--refresh` bypasses, `--no-cache` skips writing.
  - Requires `APIFY_API_TOKEN` in a `.env` next to the workspace (or in shell env).

  **Import a LinkedIn or X post by URL**

  - `acrm import post <url>` auto-detects the platform and imports the post's author as a person, then stores the post itself as a first-class record. Use when a user shares a post link they want to track (e.g. "import this tweet", "save this LinkedIn post").
  - Adds a new top-level `posts` object alongside companies / people / deals, with attributes: `url` (unique, normalized), `platform` (`linkedin` | `x`), `author` (record-reference → people), `posted_at`, `content`. Inverse on people: `associated_posts` (multivalued).
  - Idempotent: re-running the same URL keeps one post record and one author, and skips re-linking. Cached Apify responses make repeat runs free.
  - Actor selection: `apimaestro/linkedin-post-detail` for LinkedIn (single-post-by-URL with author profile URL in the response), `apidojo/twitter-scraper-lite` for X (`startUrls` with single-tweet support, same vendor as the existing X profile actor).
  - New `.claude/skills/import-post.md` skill so agents pick up the command from natural phrasings and bare post URLs in chat.

  **`status` / `select` attributes now store `{id, title}`**

  - Previously passing a bare string (e.g. `"lead"` for `deal.stage`) stored `{"title":"lead"}`, dropping the id and using the lowercase id as the display title. The `encode()` function now resolves a string input against the attribute's `options` config (case-insensitive match on `id` or `title`) and stores the canonical `{id, title}` pair. This applies to both `acrm import csv` (deal stage) and the new `acrm import post` (platform).
  - Falls back to the old `{title: raw}` behavior when an attribute has no `options` config or the input doesn't match any option, so freeform statuses still work.

  **CSV import reliability + UI polish**

  - Multiple fixes to `acrm import csv` to handle real-world CSVs more reliably (header normalization, person/company dedup edge cases, batched writes, monotonic UUIDv7 generation to keep insert order stable when rows land within the same millisecond).
  - Deals icon tweak in the local UI.

  **Internal**

  - Reusable `importLinkedinProfile()` / `importXProfile()` helpers extracted from the CLI wrappers so the new post-import flow can chain into them without re-opening the workspace. Existing CLI behavior for `acrm import linkedin` / `acrm import x` is unchanged.
  - Removed unused skills: `champion-left`, `csv-import`, `new-hire-trigger`, `stale-opportunities`.

## 0.0.7

### Patch Changes

- 12f315e: Improve `acrm import csv` reliability and discoverability:

  - People can now be identified by LinkedIn URL or Twitter/X URL in addition to email. Dedup
    priority is email → LinkedIn → Twitter. URLs are normalized
    (protocol/www/query/fragment/trailing-slash stripped, twitter.com unified to x.com, bare
    handles like `@foo` accepted).
  - Companies without a domain or email are now deduplicated by case-insensitive name instead
    of being skipped or duplicated.
  - CSV header parsing now collapses whitespace to underscores, so headers like `Company Name`
    work the same as `company_name`.
  - Person name resolution accepts more aliases: `who`, `contact`, `contact_name` (in addition
    to `name`, `full_name`, `person_name`, and `first_name` + `last_name`).
  - When an import produces zero records, diagnostic warnings explain why (e.g. no recognized
    person/company identifier columns).
  - The UI is now spawned as a detached background process after import so the import command
    returns immediately. The JSON response includes a `ui: { pid, url, stop }` handle so callers
    can find and terminate the background server (`stop` is a ready-to-paste `kill <pid>`
    command).
  - `acrm --version` now reads from `package.json` instead of being hardcoded.
