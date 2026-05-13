# Transcript providers

Provider adapters used by `/setup-transcripts` and `/post-call`. The agent-crm
CLI (`acrm import transcript`) is provider-agnostic — it accepts canonical
JSON. Adapters live here and translate from a vendor's native data shape into
that canonical shape.

## Registry

| Provider     | Adapter file       | Connection mode | Status        |
| ------------ | ------------------ | --------------- | ------------- |
| Granola      | `granola.md`       | MCP server (OAuth) | implemented |
| Manual / file| `manual.md`        | user pastes/uploads transcript | always available |

To add Otter, Fireflies, Fathom, Read.ai, Circleback, Zoom native, etc.,
follow the contract below.

## Adapter contract

Every adapter document must expose four sections so `/setup-transcripts` and
`/post-call` can read it and behave correctly without hardcoding vendor names
into the skills:

1. **`## Detect`** — How to check if this provider is connected and usable
   right now. One of:
   - Probe an MCP tool (e.g. `mcp__<name>__list_meetings` returns without
     auth error).
   - Read an env var from the workspace `.env` (e.g. `OTTER_API_KEY`).
   - Check for a known file/directory.
   - "Always available" (manual / file-based adapters).

2. **`## Connect`** — Step-by-step instructions to authenticate or configure
   the provider. May be a no-op for manual adapters.

3. **`## Fetch`** — Given a meeting selector (date range, person, or
   pasted ID/URL), return:
   - `source_id` (string, unique per meeting in that provider)
   - `title`, `started_at`, `ended_at`, `duration_seconds` (optional)
   - `content` (raw transcript text)
   - `participants[]` (array of `{ email }` objects — emails are how the
     CLI resolves them to existing `people` records)

4. **`## Canonical source slug`** — The string to use as `source` in the
   canonical JSON. Must be one of the values allowed by the `transcripts.source`
   status attribute in `src/commands/init.ts` (`granola`, `zoom`, `meet`,
   `teams`, `manual`, `other`). Extend the status options in `init.ts` when
   adding a new provider whose value isn't already there.

## Canonical JSON shape (recap)

```json
{
  "source":     "granola",
  "source_id":  "<provider-meeting-id>",
  "title":      "...",
  "started_at": "ISO-8601",
  "ended_at":   "ISO-8601",
  "duration_seconds": 1800,
  "summary":    "...",
  "content":    "<raw transcript>",
  "participants": [{ "email": "..." }]
}
```

This is what `/post-call` builds and pipes to `acrm import transcript`.
