---
"@agent-crm/cli": patch
---

Fix two drift defects in the `/post-call` skill.

**1. DataFusion placeholder syntax.** Step 1's person-lookup SQL used SQLite-style `?` placeholders, which `acrm execute` rejects with `LIX_PARSE_ERROR: unsupported SQL parameter placeholder '?'`. Switched to DataFusion's numbered `$1` placeholders, escaped as `\$1` inside double-quoted shell strings so the shell doesn't expand them before `acrm` sees them. Added a one-line note pointing future editors at the dialect.

**2. Stale customer-discovery template.** Step 4 forced every transcript through a fixed schema (`problem`, `current_workaround`, `frequency`, `would_pay`, `questions_asked`, `notes`) carried over from an earlier project, then composed those into a structured `summary` block. The agent-crm `transcripts` schema treats `summary` as an opaque text blob — no such fields exist — so the template produced nonsense on peer-to-peer / non-discovery meetings (e.g. "Would pay: blank — Luis is building, not buying"). Replaced step 4 with a short free-form prose summary (prefer the adapter's own summary when present, e.g. Granola's). Updated step 5's confirmation preview and step 6's JSON example to match.

Both fixes applied to `skills/post-call.md` (the canonical copy that ships via the postinstall hook).
