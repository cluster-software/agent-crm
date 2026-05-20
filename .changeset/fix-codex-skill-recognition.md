---
"@agent-crm/cli": patch
---

Fix Codex skill recognition: four bundled skills (`acrm-query`, `post-call`,
`prep-call`, `setup-transcripts`) were missing the `name:` field in their
SKILL.md frontmatter. Codex requires both `name` and `description` and
silently skipped these skills at session start. Add `name:` to all four —
existing installs re-sync on next `acrm skills install` / npm postinstall
because the source file hashes changed.
