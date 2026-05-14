---
"@agent-crm/cli": minor
---

Fix `acrm ui` Deals page, add a clickable Person detail view, and stop the `acrm execute` shell-quoting footgun at the source.

**Deals page (CLU-280).** `/deals` rendered "No deals yet" even when the count badge showed a non-zero number, because `renderDealsPage` had no list query — only the count query existed. Added `loadDeals` (joins `acrm_record` with `acrm_value` rows for `name`, `stage`, `value`, `close_date`, `next_step`, and `associated_company` via `ref_record_id`) and a real table renderer; the empty state now only shows when there are zero deals.

**People page columns.** Added Email (first value from the multivalued `email_addresses`) and X (`twitter_url`) columns next to Role / Company / LinkedIn, matching the issue request to surface those identifiers directly in the list.

**Companies "Type" column.** The header read "Type" but the cell rendered `description` — fixed by renaming the header to "Description". (The schema has no `type` attribute on companies.)

**Person detail page (`/people/:id`).** Inspired by Granola's contact view. Each row in the People table is now clickable (real `<a>` on the name for keyboard / cmd-click, plus a single delegated row-click handler that ignores inner links so the inline `mailto:` / linkedin / x cells keep working). The detail page has a hero (avatar + Inter-rendered name), contact rows with mail / LinkedIn / X icons, and a reverse-chronological timeline of associated transcripts grouped by `Today` / `Yesterday` / `Thu, Apr 30` (year is appended for older entries). Transcript subtitles list other participants (`"Enrique"` or `"Shawn, Samuel & 3 others"`). Driven by `loadTranscriptsForPerson`, which queries `acrm_value` where `attribute_slug='participants' AND ref_record_id=$1`, joins each transcript's `title` + `started_at`, and runs a second query for the other participants' names.

**`acrm execute` shell-quoting guardrail.** The recurring symptom: `acrm execute "UPDATE … WHERE id = $1" '[...]'` failed with `LIX_PARSE_ERROR at column 30` because zsh/bash had already expanded `$1` to the shell's (empty) first positional arg before the CLI even saw it. Three layers now prevent it:

- **Runtime detection.** If `params` were passed but the SQL contains zero `$N` placeholders, `acrm execute` fails fast with a directive that names the cause and shows the single-quoted fix, rather than surfacing the misleading DataFusion parse error.
- **`--help` text.** A new "SHELL QUOTING (read this first — it's the #1 footgun)" block sits above the SQL-dialect notes with ❌/✅ examples and a JSON-inside-single-quotes example. The one-liner description now opens with `SHELL: SINGLE-QUOTE the SQL whenever it contains $1/$2/...`.
- **Skill cheat-sheet.** `skills/acrm-query.md` — the file Claude Code (and Codex / Cursor via the installer) reads *before* writing SQL — gains a "Shell quoting" section near the top, so most agents avoid the mistake without ever needing the runtime guard.
