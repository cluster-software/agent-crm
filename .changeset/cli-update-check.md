---
"@agent-crm/cli": minor
---

Detect when the installed `acrm` CLI is outdated and prompt to update before continuing. Fixes #47.

**Interactive TTY (humans).** When both stdin and stdout are TTYs, `acrm` shows a Codex-style block before running the command:

```
✨ Update available! 0.1.0 → 0.9.0

Release notes: https://github.com/cluster-software/agent-crm/releases/latest

› 1. Update now (runs `npm install -g @agent-crm/cli@latest`)
  2. Skip

Press enter to continue
```

Arrow keys (or number keys) move the cursor; Enter confirms. "Update now" runs `npm install -g @agent-crm/cli@latest` with inherited stdio and exits when it finishes, asking you to re-run your command with the new binary. "Skip" continues with your original command and is remembered for the cached latest version — once a *newer* version is published, the prompt fires again.

**Non-TTY (agents, pipes, CI).** Falls back to a one-line stderr warning so agents and pipelines see the update signal without anything to interact with:

```
⚠ A newer @agent-crm/cli is available: 0.9.0 (you are using 0.1.0).
  Run: npm install -g @agent-crm/cli@latest
```

This was the original ask in #47 — agents reading `acrm --help` need an explicit, parseable instruction to update before initializing a workspace.

**How the version check works.** On every CLI startup, `acrm` reads `~/.config/acrm/update-check.json` (honors `ACRM_CONFIG_DIR`). If the cache shows a newer published version, the prompt or warning fires. If the cache is missing or older than 24h, a detached, unref'd worker is spawned that hits `registry.npmjs.org/@agent-crm/cli/latest` and rewrites the cache — the current command returns immediately and the *next* invocation sees the fresh result. Same pattern npm itself uses.

**Output stays clean.** All update-check output goes to **stderr**, never stdout. `acrm execute "..." --json | jq .` parses normally even when a warning is firing.

**Opt-outs.** Set `ACRM_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1`, or `CI=true` to suppress entirely. Dev/pre-release versions (anything with a `-` suffix) are skipped automatically.

**No new dependencies.** ~250 lines of stdlib (`node:fs`, `node:child_process`, `node:readline`), including a small numeric semver comparator so `0.10.0 > 0.9.0` works correctly.
