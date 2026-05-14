# @agent-crm/cli

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
