---
description: After a meeting, pull its transcript from whichever provider you have connected (Granola, manual paste/file, etc.) and import it into the .acrm workspace as a `transcripts` record linked to the attendees. Provider-agnostic.
---

Argument: `$ARGUMENTS` is a person identifier — name, email, or `record_id` —
or it can be blank when the user just wants the most recent meeting. If empty,
ask the user which person or which meeting.

This is re-runnable. The `transcripts` record is deduped by the provider's
meeting id (`source_id`), so importing the same meeting twice updates fields
in place without duplicating participant links.

**Fast path (Granola):** the CLI fetches the transcript directly via
`acrm import transcript --from granola <meeting-id>` — transcript bytes never
pass through the model. Sub-5s end-to-end.

**Manual path:** for any source without a native CLI adapter, the user pastes
or supplies a file and you build canonical JSON for `acrm import transcript`.

## Steps

1. **List meetings and pick the one to import.** Use Granola's MCP if it's
   connected:
   ```
   mcp__granola__list_meetings  time_range: last_week
   ```
   Filter by `$ARGUMENTS` if present (match against meeting title or
   participants). Resolve to a single `meeting_id` UUID:
   - 0 matches → ask the user to paste a Granola meeting URL; extract the UUID.
   - 1 match → use it.
   - 2+ matches → numbered list (title, date), ask the user.

   If Granola isn't connected (`mcp__granola__*` tools not in the session),
   skip to the **Manual path** below.

2. **Import via the CLI in one call.** Do not read the transcript yourself.
   Do not paste transcript bytes into a heredoc.

   ```sh
   acrm import transcript --from granola <meeting-id> --json
   ```

   The CLI fetches the transcript + summary + participants, upserts the
   `transcripts` record, resolves participants by email → linkedin → twitter,
   backfills missing identifiers on existing matches, and auto-creates `people`
   records for unknown attendees that carry at least one identifier.

   If the CLI reports `not authenticated`, tell the user to run
   `acrm auth granola` once and retry — the CLI prints an OAuth URL and caches
   the token at `~/.config/acrm/granola.json`.

3. **Report back.** Parse the JSON the CLI returned and surface:
   - `transcript_record_id`
   - Provider URL (Granola: `https://notes.granola.ai/t/<source_id>`).
   - Resolved vs created vs unresolved participants. `created: true` means
     the CLI auto-created a `people` record from the participant's identifier
     — call those out so the user knows new people were added.
   - One key quote or insight if you have one (you may read the transcript
     from `acrm execute` *after* the import if the user asks; do not pre-load
     it into the conversation).

## Manual path

When no native CLI adapter exists for the source (Otter, Fireflies, Fathom,
Zoom export, audio you transcribed yourself, etc.):

1. Ask the user to paste the transcript and supply:
   - A unique meeting identifier (URL or stable string) → becomes `source_id`.
   - Title (optional), start/end times (optional).
   - Participants — at least one of `email` / `linkedin_url` / `twitter_url`
     per attendee.

2. Write the canonical JSON to a temp file and import:
   ```sh
   cat > /tmp/transcript-<source_id>.json <<'EOF'
   {
     "source": "manual",
     "source_id": "<URL-or-stable-id>",
     "title": "<title or omit>",
     "started_at": "<ISO 8601 or omit>",
     "summary": "<short prose summary, optional>",
     "content": "<pasted transcript>",
     "participants": [
       { "email": "<email>" },
       { "linkedin_url": "<linkedin-url>" },
       { "twitter_url": "<twitter-url>" }
     ]
   }
   EOF
   acrm import transcript --file /tmp/transcript-<source_id>.json --json
   ```

   The CLI handles dedup, multi-identifier resolution, backfill, and
   auto-creation of unknown participants — same code path as `--from granola`.
   Heredoc must use `'EOF'` (quoted) so `$` characters in the transcript don't
   get expanded by the shell.

   Delete the temp file after import.

## File writes allowed

- `.acrm` mutations only via `acrm import transcript`.
- Temp files at `/tmp/transcript-*.json` for the manual path; delete after import.
- No artefact files unless the user asks.

## Out of scope

- Deal-stage updates and `next_steps` on deals — handle in a separate flow.
- Curating the transcript summary inside the model. Provider summary is the
  default for Granola; if the user wants to edit it, do that after the import
  via `acrm execute` (UPDATE `transcripts.summary`).
