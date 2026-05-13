---
"@agent-crm/cli": patch
---

Fix `/post-call` silently falling back to manual when Granola's MCP server isn't registered with Claude Code.

The Granola adapter's Detect/Connect protocol previously conflated two distinct failure modes — "MCP server not registered with the harness" and "MCP server registered but unauthenticated" — into a single "not connected" bucket. When the `mcp__granola__*` tool symbols didn't exist in the session at all, `/post-call` treated it the same as expired auth and dropped through to the manual adapter, never telling the user the one thing that would actually fix it: run `claude mcp add --transport http granola https://mcp.granola.ai/mcp` and restart Claude Code.

**Three-state Detect contract.** `transcript-provider-*` adapters now report one of `connected`, `unauthenticated`, or `not_installed`. The new `not_installed` state has its own recovery section (`## Install`) that surfaces the exact shell command and stops the flow instead of degrading silently.

**Updated files:**
- `skills/transcript-provider-granola.md` — Detect now branches on tool-symbol availability; new `Install` section.
- `skills/post-call.md` — step 2 routes on the three states; step 3 distinguishes `Install` from `Connect` recovery.
- `skills/setup-transcripts.md` — menu and connect loop honor all three states.
- `docs/transcript-provider-protocol.md` — adapter contract documents the three-state Detect plus the new `Install` section, so future `transcript-provider-*` adapters follow the same shape.

Silent fallback to manual now only happens when no native adapter is installed at all, or when the user explicitly opts in ("just use manual for this one").
