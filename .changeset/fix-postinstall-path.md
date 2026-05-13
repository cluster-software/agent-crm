---
"@agent-crm/cli": patch
---

Fix `npm install -g @agent-crm/cli` not actually installing skills on a fresh install. The postinstall bootstrap (`postinstall.cjs`) was resolving the installer at `<pkg>/../dist/scripts/install-skills.js` — one level too high — so the `existsSync` guard always returned false and the script silently no-op'd. Result: skills weren't written to `~/.claude/skills/`, `~/.codex/skills/`, or `~/.cursor/skills/`, and `~/.acrm/skills.lock.json` was never created. Manual recovery via `acrm skills install` worked as a workaround. Fixed by correcting the path; the `acrm skills install` CLI command was unaffected because it resolves the source from `dist/commands/skills.js`, which has the right relative depth.
