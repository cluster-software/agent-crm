# Manual / file adapter

For any provider that doesn't have a native integration yet (Otter, Fireflies,
Fathom, Read.ai, Circleback, Zoom export, audio recording you transcribed
yourself, etc.). The user pastes or uploads the transcript and you build the
canonical JSON by hand.

This adapter is always available and is the fallback when no native provider
is connected.

## Canonical source slug

Use the closest match from the `transcripts.source` status attribute:
`zoom`, `meet`, `teams`, or `manual`. If unsure, use `manual`.

To add a new option (e.g. `otter`, `fireflies`), extend the status options on
the `transcripts.source` attribute in `src/commands/init.ts` and re-run
`acrm init` on the workspace.

## Detect

Always available. No connection required.

## Connect

No-op. Skip this section in `/setup-transcripts`.

## Fetch

There is no API to call — the user supplies the transcript. Two paths:

**A. Paste in chat.** Ask the user to paste:
   1. The transcript text.
   2. A unique meeting identifier (a URL or any stable string — this becomes
      `source_id` and prevents duplicate imports).
   3. Meeting title (optional).
   4. Meeting start time, ISO 8601 (optional).
   5. The participant emails (so participants can be linked to existing
      `people` records).

**B. File on disk.** Ask the user for a path to a JSON file already in the
canonical shape, then run:
```sh
acrm import transcript --file <path>
```

## Map to canonical

For path A, build the JSON inline:

```json
{
  "source":     "manual",
  "source_id":  "<URL-or-stable-id-from-user>",
  "title":      "<from user>",
  "started_at": "<ISO 8601 from user, or omit>",
  "content":    "<pasted transcript>",
  "summary":    "<filled in by caller, e.g. /post-call>",
  "participants": [{ "email": "<email>" }, ...]
}
```

For path B, the user is responsible for the file's shape — no mapping needed.
