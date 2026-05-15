---
"@agent-crm/cli": minor
---

Detect when the installed `acrm` CLI is outdated and prompt agents/users to update before continuing.

**Why.** Agents follow whichever `acrm` is already on the box. If an old global install lingers (e.g. `0.1.0`), the agent proceeds with stale `init` behavior and misses newer affordances. Filed as #47.

**How it works.** On every CLI startup, `acrm` reads `~/.config/acrm/update-check.json` (honors `ACRM_CONFIG_DIR`). If a newer version is cached, it prints to **stderr**:

```
⚠ A newer @agent-crm/cli is available: 0.9.0 (you are using 0.1.0).
  Run: npm install -g @agent-crm/cli@latest
```

If the cache is missing or older than 24h, `acrm` spawns a detached, unref'd worker that hits `registry.npmjs.org/@agent-crm/cli/latest` and rewrites the cache. The current command returns immediately — the *next* invocation sees the fresh result. Same pattern npm itself uses.

**Output stays clean.** The warning is stderr-only, so `--json` stdout remains parseable.

**Opt-outs.** Set `ACRM_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1`, or `CI=true` to suppress entirely. Dev/pre-release versions (anything containing a `-` suffix) skip the check.

**No new dependencies.** ~150 lines of stdlib, including a tiny numeric semver comparator (so `0.10.0 > 0.9.0` works correctly).
