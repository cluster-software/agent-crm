---
"@agent-crm/cli": minor
---

Resolve transcript participants by any of email / LinkedIn URL / Twitter URL, with backfill of missing identifiers.

`acrm import transcript` used to require an `email` on every participant and resolved them with a single lookup against `people.email_addresses`. A meeting attendee whose `people` record carried only a LinkedIn URL (or whose record had a different email than what the meeting provider supplied) landed in `unresolved` even though the workspace held a unique identifier that unambiguously matched them. The CSV import path already did the right thing — email → linkedin → twitter cascade — but the cascade lived inline and the transcript path never picked it up.

**Shared resolver.** New `src/domain/resolve-person.ts` exposes `resolvePersonByIdentifiers(lookup, ids)` running the canonical email → linkedin → twitter cascade. Both `acrm import csv` and `acrm import transcript` now funnel through this helper. The next identifier added (phone, handle, …) lands in one place.

**Multi-identifier participants.** The canonical transcript JSON now accepts `{ email?, linkedin_url?, twitter_url? }` per participant, with at least one required. Email-only payloads keep working — pure superset. The CLI's `--help` and `docs/transcript-provider-protocol.md` describe the new shape; the `transcript-provider-granola` and `transcript-provider-manual` adapter skills pass identifiers through instead of forcing every attendee into an email-shaped slot.

**Backfill on match.** When a participant resolves by LinkedIn/Twitter and the payload also carried an email (or vice versa) that the matched record didn't have, the CLI writes the missing identifier onto the record so the next import resolves directly. Single-value attributes (`linkedin_url`, `twitter_url`) are only filled when currently empty — curated values are never clobbered. Multi-value `email_addresses` dedupes on the normalized key. The result JSON's `resolved[].backfilled[]` lists which identifiers were written.

**Better `unresolved` shape.** `unresolved[]` now carries `identifiers` (the normalized inputs that were probed), `tried` (which attribute indexes were hit), and `reason` of either `person_not_found` (at least one identifier was tried but missed) or `no_identifier_provided` (every supplied identifier normalized to empty). Self-debugging from the JSON output alone.

**Test suite.** Added `src/domain/resolve-person.test.ts` (pure unit tests on normalization + cascade priority + skipped-when-null branches) and `src/commands/import-transcript.test.ts` (integration tests against an in-memory workspace covering email match, LinkedIn match, Twitter match, email-priority-over-linkedin, backfill of missing email, backfill of missing LinkedIn, no-clobber of curated LinkedIn, unresolved with `tried[]`/`reason`, idempotent re-import, malformed/empty-identifier rejection). 32 tests across the suite, all green.
