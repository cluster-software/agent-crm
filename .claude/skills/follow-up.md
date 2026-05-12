---
name: follow-up
description: Find leads that need a reply, read the prior thread (including any transcripts from past calls), and draft a follow-up message in the user's tone of voice. Reads from `.acrm` via `acrm execute "<sql>"`; transcripts are pulled via `people.associated_transcripts`.
---

# follow-up

Use when the user says "who do I need to follow up with?", "draft my follow-ups", or "show me stale leads".

## Run

1. **Query for stale opens.** Active deal stages from the seed schema are `lead`, `in_progress`, `won`, `lost`; "open" means stage in `('lead', 'in_progress')`.

   ```sh
   acrm execute "
     SELECT d.record_id AS deal_id,
            (SELECT json_extract(value_json, '$.value') FROM acrm_value
              WHERE object_slug = 'deals' AND record_id = d.record_id
                AND attribute_slug = 'name' AND active_until IS NULL LIMIT 1) AS deal_name,
            (SELECT json_extract(value_json, '$.id') FROM acrm_value
              WHERE object_slug = 'deals' AND record_id = d.record_id
                AND attribute_slug = 'stage' AND active_until IS NULL LIMIT 1) AS stage,
            (SELECT MAX(active_from) FROM acrm_value
              WHERE object_slug = 'deals' AND record_id = d.record_id) AS last_activity
     FROM acrm_record d
     WHERE d.object_slug = 'deals'
   " --json
   ```

   Filter the rows in-process: stage in `('lead', 'in_progress')` AND `last_activity` older than 7 days (or whatever threshold the user gave).

2. **For each stale deal, pull recent context.** Resolve the associated person and recent value rows so the draft is grounded in what actually happened:

   ```sh
   acrm execute "SELECT ref_record_id FROM acrm_value WHERE object_slug = 'deals' AND record_id = ? AND attribute_slug = 'associated_people' AND active_until IS NULL LIMIT 1" '["<deal-record-id>"]' --json

   acrm execute "SELECT attribute_slug, value_json, source, active_from FROM acrm_value WHERE object_slug = 'people' AND record_id = ? ORDER BY active_from DESC LIMIT 10" '["<person-record-id>"]' --json
   ```

   Then pull recent transcripts linked to that person via `people.associated_transcripts` and read the `summary` / `content` fields for prior-call context:

   ```sh
   acrm execute "SELECT ref_record_id FROM acrm_value WHERE object_slug = 'people' AND record_id = ? AND attribute_slug = 'associated_transcripts' AND active_until IS NULL ORDER BY active_from DESC LIMIT 3" '["<person-record-id>"]' --json

   acrm execute "SELECT attribute_slug, value_json FROM acrm_value WHERE object_slug = 'transcripts' AND record_id = ? AND attribute_slug IN ('summary','title','started_at') AND active_until IS NULL" '["<transcript-record-id>"]' --json
   ```

   Also read other text-typed attributes on the person (`notes`, etc.) that capture prior thread.

3. **Calibrate tone.** Read 5 of the user's recent sent messages to match voice, length, and signoff. Don't invent a tone — mirror what's there. If the user has no reachable sent-mail context, ask them to paste a few examples.

4. **Draft a message per person.** Save all drafts to `./drafts/follow-ups-<YYYY-MM-DD>.md`:
   ```
   ## <Name> — <Company>
   Last touch: <date> — <one-line context>

   ---
   <draft message>
   ---
   ```

5. **Show the file path and a count.** The user reviews and edits before sending.

## Hard rule

Never send a message. Drafts only. Sending requires explicit user action.
