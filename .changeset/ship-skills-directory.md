---
"@agent-crm/cli": minor
---

Ship bundled skills to Claude Code, Codex, and Cursor on `npm install`.

**Automatic multi-agent skill installation.** `npm install -g @agent-crm/cli` (and every `npm update`) now writes every acrm skill into each installed AI agent's user-scoped skills directory via an `postinstall` hook:

- Claude Code: `~/.claude/skills/<name>/SKILL.md`
- Codex: `~/.codex/skills/<name>/SKILL.md`
- Cursor: `~/.cursor/skills/<name>/SKILL.md`

Idempotent (hash-gated drift detection), error-tolerant (never aborts `npm install`), and only ever touches paths recorded in its lockfile at `~/.acrm/skills.lock.json`.

**New `acrm skills` command** for manual control:

- `acrm skills install [--agents <list>]` — re-sync (also the fallback for `--ignore-scripts` installs)
- `acrm skills list` — show what's installed where
- `acrm skills remove` — uninstall every acrm skill from every agent

**Transcript providers promoted to first-class skills.** Files that used to live in `.claude/transcript-providers/` now ship as regular skills following the `transcript-provider-<vendor>` naming convention (`transcript-provider-granola`, `transcript-provider-manual`). Same agent-readable contract (Detect / Connect / Fetch / Map-to-canonical), same composition by `/post-call` and `/setup-transcripts` — they just ship through the standard skill mechanism now. Adding a new provider (Otter, Fireflies, Fathom, etc.) is a one-file operation: drop `transcript-provider-<vendor>.md` into `skills/` following the contract in `docs/transcript-provider-protocol.md`.

**Generalized `skills/` directory** at the repo root is the new canonical source (moved from `.claude/skills/`). Agent-agnostic location, ships cleanly in the tarball, one source of truth for all three agents.

The per-agent directory conventions are ported from `vercel-labs/skills@1.5.6`; the installer itself is bundled inside the CLI (no runtime dependency on `npx skills`) so installs work offline and never fetch a remote manifest.
