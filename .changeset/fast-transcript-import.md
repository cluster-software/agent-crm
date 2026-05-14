---
"@agent-crm/cli": patch
---

Fast transcript import — keep transcript bytes off the LLM path.

`/post-call` used to take ~4 minutes per Granola import because the LLM re-emitted the 39 KB transcript verbatim into a heredoc to build the canonical JSON. The CLI itself ran in ~1s; the rest was tokens. Bytes flowed *through the model as output tokens*. That's the bug.

**New CLI surface.** `acrm import transcript --from <provider> <meeting-id>` fetches the transcript + summary + participants directly from the provider and writes in one shot. Granola is the only adapter today; the `--file` and stdin paths remain unchanged for anything without a native adapter.

```sh
acrm import transcript --from granola 0c8c3f6e-...
acrm import transcript --file ./transcript.json
```

**`acrm auth granola`.** OAuth 2.0 + PKCE with discovery via `${endpoint}/.well-known/oauth-authorization-server`. Opens a local-loopback callback server, exchanges the code, caches the token at `~/.config/acrm/granola.json` (mode 0600). Override the cache dir via `ACRM_CONFIG_DIR`. Escape hatch: `acrm auth granola --token <token>` skips the browser flow when the user already has a token in hand.

**Auto-create unknown participants.** When a participant carries at least one identifier (email / LinkedIn URL / Twitter URL) but no `people` record matches, the CLI now creates the record on the spot and links it as a resolved participant with `matched_by: "created"` and `created: true`. Mirrors the behavior of `acrm import linkedin`, which already auto-creates companies. Closes the "Enrique unresolved" failure mode from the spec.

**Always use the provider's summary.** No `--summary-from` flag. If the user wants a different summary, they edit after the fact via `acrm execute`.

**Updated `/post-call` skill.** Three steps: list meetings via MCP, pick the UUID, run `acrm import transcript --from granola <uuid>`. No transcript bytes through the model. Sub-5s end-to-end.

**Test suite.** Added:
- `src/lib/token-cache.test.ts` — round-trip, 0600 mode, ACRM_CONFIG_DIR override, expiry helpers.
- `src/lib/oauth-pkce.test.ts` — verifier/challenge correctness against SHA-256, base64url charset, authorization-URL parameter encoding, scope omission, query-string preservation on the auth endpoint.
- `src/integrations/mcp-http-client.test.ts` — JSON-RPC envelope shape, Bearer header, 401 → friendly hint, JSON-RPC error surfacing, SSE/streamable-HTTP body parsing, tool-result unwrapping.
- `src/integrations/granola.test.ts` — transcript content extraction across shapes (`content`/`transcript`/`text`/nested), case-insensitive meeting-id match, attendees fallback, single-meeting-object shape, NOT_FOUND on miss, end-to-end fetch with mocked HTTP that builds canonical TranscriptPayload (including duration derived from start/end).
- `src/commands/import-transcript.autocreate.test.ts` — auto-create from email, from LinkedIn alone, with all three identifiers, bidirectional link to the new record, idempotent re-import (no duplicate person on second pass).

69 tests across 8 files, all green.

**Out of scope (intentionally).** `--latest`/`--match`/`--since` (meeting discovery stays in the skill), `--link`/`--no-create-people` (auto-create is the default, no flag), `--force`/`--dry-run` (dedup by `source_id` is enough), reading the MCP server's token store (`~/.config/acrm/<provider>.json` is the only token location), exit-code taxonomy (one non-zero is enough).
