---
"@agent-crm/cli": patch
---

Fix drift in `/setup-transcripts` and `/transcript-provider-granola` after `acrm auth granola` and the fast-path transcript fetch landed.

Both skills predated the 0.4.1 split that introduced a CLI-side OAuth flow (`acrm auth granola`, token at `~/.config/acrm/granola.json`) on top of the existing Claude Code MCP registration. The granola provider now touches **two independent auth surfaces** — MCP for `mcp__granola__list_meetings` (meeting discovery in the model session) and the CLI for `acrm import transcript --from granola` (transcript fetch outside the model) — and the skills modeled only the first. End state: `/setup-transcripts` would report Granola "connected" when the CLI token was missing, and `/post-call` step 2 would then crash with "no cached Granola credentials found".

**`skills/transcript-provider-granola.md`.**

- Header now spells out both auth surfaces and notes the token stores are independent.
- **Detect** probes both surfaces and returns a *composite* state (worst of the two). Tool-symbol absent → `not_installed`; either surface unauthenticated → `unauthenticated`; both connected → `connected`. CLI surface is checked via `test -f "${ACRM_CONFIG_DIR:-$HOME/.config/acrm}/granola.json"`. The adapter is now required to name *which* surface is failing when surfacing state.
- **Connect** split into `A. MCP surface` (in-session `mcp__granola__authenticate` → `mcp__granola__complete_authentication`) and `B. CLI surface` (`! acrm auth granola` from the user's own shell — the `!` prefix is load-bearing because Claude Code's bash tool buffers stdout/stderr and would hide the URL while the command blocks on the OAuth callback, per the 0.4.2 changelog). Captures DCR-is-automatic, token location, mode 0600, and the `--token` escape hatch.
- **Fetch** rewritten around the fast path: the model resolves a `meeting_id` UUID and hands it to `acrm import transcript --from granola <meeting-id>`. Explicit "don't fetch transcript bytes inside the model" call-out, with the 4 min → sub-5s reason from the 0.4.1 changelog. Prompt-injection hygiene note reframed around the summary (the only thing the model now sees) instead of raw transcript bytes.
- **Map to canonical** reframed as documentation of what the CLI emits internally (rather than what the model builds). Updated to reflect 0.4.0/0.4.1 behavior: multi-identifier participants (`email` / `linkedin_url` / `twitter_url`), always-use-provider-summary (no `--summary-from`), backfill + auto-create on resolve.

**`skills/setup-transcripts.md`.**

- Status menu now shows the four real Granola states (not installed / MCP-only / CLI-only / both) and the prose tells the composing skill to name which surface needs work when state is not `connected`.
- Step 3 recovery for Granola spells out both Connect sub-flows with the `!` prefix rationale.

No code changes. Skills-only.
