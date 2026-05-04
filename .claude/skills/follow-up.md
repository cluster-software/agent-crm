---
name: follow-up
description: Find leads that need a reply, read the prior thread, and draft a follow-up message in the user's tone of voice.
---

# follow-up

Use when the user says "who do I need to follow up with?", "draft my follow-ups", or "show me stale leads".

## Run

1. **Query for stale opens.**
   ```bash
   acrm people list --filter "last_activity < 7d AND deal_status = open" --json
   ```
   Adjust the threshold if the user specifies one.

2. **For each person, pull recent context:**
   ```bash
   acrm activities list --person-id <id> --limit 3 --json
   ```
   Read the last thread (transcript, email, or note) so the draft is grounded in what was actually said.

3. **Calibrate tone.** Read 5 of the user's recent sent messages to match voice, length, and signoff. Don't invent a tone — mirror what's there.

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
