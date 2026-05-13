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

Every adapter document must expose the sections below so `/setup-transcripts`
and `/post-call` can read it and behave correctly without hardcoding vendor
names into the skills:

1. **`## Detect`** — How to check this provider's state right now. Must
   return one of three states (not just connected/not-connected):
   - `connected` — usable immediately.
   - `unauthenticated` — wiring is in place but credentials are missing or
     expired. Run `Connect` to fix.
   - `not_installed` — the wiring itself is missing (MCP server not
     registered with the harness, required CLI not on `$PATH`, env var
     completely absent, etc.). Run `Install` to fix.

   Probe shapes:
   - MCP tool (e.g. `mcp__<name>__list_meetings`): tool symbol absent →
     `not_installed`; auth error → `unauthenticated`; success → `connected`.
   - Env var (e.g. `OTTER_API_KEY`): missing → `not_installed`;
     present but rejected by the provider → `unauthenticated`;
     present and accepted → `connected`.
   - Known file/directory: same shape.
   - "Always available" (manual / file-based adapters): always `connected`;
     no `Install` or `Connect` needed.

2. **`## Install`** — Step-by-step instructions to put the wiring in place
   when state is `not_installed`. Typically a user-initiated shell command
   (e.g. `claude mcp add ...`, setting an env var) plus any required session
   restart. Skills must **not** silently fall back to a different adapter when
   this state is observed — they should surface the exact command and stop.
   Omit this section only for adapters that can never be `not_installed`
   (e.g. manual / file-based).

3. **`## Connect`** — Step-by-step instructions to authenticate or configure
   the provider when state is `unauthenticated`. May be a no-op for manual
   adapters.

4. **`## Fetch`** — Given a meeting selector (date range, person, or
   pasted ID/URL), return:
   - `source_id` (string, unique per meeting in that provider)
   - `title`, `started_at`, `ended_at`, `duration_seconds` (optional)
   - `content` (raw transcript text)
   - `participants[]` — array of objects, each carrying at least one of
     `email`, `linkedin_url`, `twitter_url`. The CLI resolves participants
     to existing `people` records using priority email → linkedin → twitter,
     and backfills missing identifiers on the matched record. Pass
     whichever identifiers the source actually has — don't synthesize.

5. **`## Canonical source slug`** — The string to use as `source` in the
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
  "participants": [
    { "email": "alice@acme.com" },
    { "linkedin_url": "linkedin.com/in/bob-jones" },
    { "email": "carol@acme.com", "linkedin_url": "linkedin.com/in/carol" }
  ]
}
```

Each participant must carry at least one of `email` / `linkedin_url` /
`twitter_url`. The CLI returns `participants.unresolved[]` for any whose
identifiers don't match an existing person, with a `tried` array listing
which attributes were probed and a `reason` of either `person_not_found`
(at least one identifier was probed) or `no_identifier_provided` (every
identifier normalized to empty).

This is what `/post-call` builds and pipes to `acrm import transcript`.
