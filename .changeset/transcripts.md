---
"@agent-crm/cli": minor
---

Add a `transcripts` object to the data model and a provider-agnostic ingestion path.

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
