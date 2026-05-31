---
name: follow-up
description: Find leads that need a reply, read the prior thread (including any transcripts from past calls), and draft a follow-up message in the user's tone of voice. Reads from the Postgres workspace via `acrm execute "<sql>"`; transcripts are pulled via `people.associated_transcripts`.
---

# follow-up

Use when the user says "who do I need to follow up with?", "draft my follow-ups", or "show me stale leads".

## Run

### 1. Find threads needing a reply

Run this single query to get all messages with their thread, direction, timestamp, and body in one shot:

```sh
acrm execute "
  SELECT
    m_thread.ref_record_id AS thread_id,
    m_dir.value_json ->> 'id' AS direction,
    m_sent.value_json ->> 'timestamp' AS sent_at,
    m_body.value_json ->> 'value' AS body_text
  FROM acrm_value m_thread
  JOIN acrm_value m_dir
    ON m_dir.object_slug = 'communication_messages'
    AND m_dir.record_id = m_thread.record_id
    AND m_dir.attribute_slug = 'direction'
    AND m_dir.active_until IS NULL
  JOIN acrm_value m_sent
    ON m_sent.object_slug = 'communication_messages'
    AND m_sent.record_id = m_thread.record_id
    AND m_sent.attribute_slug = 'sent_at'
    AND m_sent.active_until IS NULL
  LEFT JOIN acrm_value m_body
    ON m_body.object_slug = 'communication_messages'
    AND m_body.record_id = m_thread.record_id
    AND m_body.attribute_slug = 'body_text'
    AND m_body.active_until IS NULL
  WHERE m_thread.object_slug = 'communication_messages'
    AND m_thread.attribute_slug = 'thread'
    AND m_thread.active_until IS NULL
  ORDER BY m_sent.value_json
" --json
```

From the result, group messages by `thread_id`. For each thread, find the chronologically last message. A thread needs a follow-up if:
- The last message has `direction = 'inbound'` (they messaged you, you haven't replied)
- That message is older than 2 days but newer than 90 days (stale but not dead)

Adjust thresholds if the user specifies a different window.

### 2. Resolve who is in each thread

For threads needing follow-up, get the participant names and context:

```sh
acrm execute "
  SELECT
    t_part.record_id AS thread_id,
    t_part.ref_record_id AS person_id
  FROM acrm_value t_part
  WHERE t_part.object_slug = 'communication_threads'
    AND t_part.attribute_slug = 'participants'
    AND t_part.active_until IS NULL
    AND t_part.record_id IN ('<thread_id_1>', '<thread_id_2>')
" --json
```

Then get person details (name, job_title, company) for those person IDs:

```sh
acrm execute "
  SELECT record_id, attribute_slug, value_json
  FROM acrm_value
  WHERE object_slug = 'people'
    AND record_id IN ('<person_id_1>', '<person_id_2>')
    AND active_until IS NULL
    AND attribute_slug IN ('name', 'job_title', 'company')
" --json
```

### 3. Pull transcript context (if available)

For each person needing follow-up, check for associated transcripts:

```sh
acrm execute "
  SELECT record_id, ref_record_id
  FROM acrm_value
  WHERE object_slug = 'people'
    AND record_id = '<person_id>'
    AND attribute_slug = 'associated_transcripts'
    AND active_until IS NULL
  ORDER BY active_from DESC
  LIMIT 3
" --json
```

If transcripts exist, read their summary:

```sh
acrm execute "
  SELECT attribute_slug, value_json
  FROM acrm_value
  WHERE object_slug = 'transcripts'
    AND record_id = '<transcript_id>'
    AND attribute_slug IN ('summary', 'title', 'started_at')
    AND active_until IS NULL
" --json
```

### 4. Calibrate tone

Read 5 of the user's recent outbound messages to match voice, length, and signoff:

```sh
acrm execute "
  SELECT m_body.value_json ->> 'value' AS body_text
  FROM acrm_value m_dir
  JOIN acrm_value m_body
    ON m_body.object_slug = 'communication_messages'
    AND m_body.record_id = m_dir.record_id
    AND m_body.attribute_slug = 'body_text'
    AND m_body.active_until IS NULL
  JOIN acrm_value m_sent
    ON m_sent.object_slug = 'communication_messages'
    AND m_sent.record_id = m_dir.record_id
    AND m_sent.attribute_slug = 'sent_at'
    AND m_sent.active_until IS NULL
  WHERE m_dir.object_slug = 'communication_messages'
    AND m_dir.attribute_slug = 'direction'
    AND m_dir.active_until IS NULL
    AND m_dir.value_json ->> 'id' = 'outbound'
  ORDER BY m_sent.value_json DESC
  LIMIT 5
" --json
```

Don't invent a tone — mirror what's there. If the user has no reachable sent-mail context, ask them to paste a few examples.

### 5. Draft a message per person

Save all drafts to `./drafts/follow-ups-<YYYY-MM-DD>.md`:

```
## <Name> — <Company>
Last touch: <date> — <one-line context>

---
<draft message>
---
```

### 6. Show the file path and a count

The user reviews and edits before sending.

## Hard rule

Never send a message. Drafts only. Sending requires explicit user action.
