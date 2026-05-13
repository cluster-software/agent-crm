# @agent-crm/cli

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
