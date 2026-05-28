# Local Agent CRM App Testing

Use the repo-local launcher when you want to test local `agent-crm` CLI or skill
changes through the sibling Agent CRM desktop app.

```sh
make app-dev
```

That command:

- starts `../agent-crm-sync-engine` on port `8000`
- stops any existing process already listening on that local sync port
- loads `../agent-crm-sync-engine/.env`
- overrides `PORT=8000` and `BASE_API_URL=http://localhost:8000`
- starts `../agent-crm-app` with `AGENT_CRM_SYNC_ENGINE_URL=http://localhost:8000`
- puts a temporary working-tree `acrm` wrapper first in the app's `PATH`
- seeds `.agent-crm-dev/claude` from your Claude settings
- stages the local bundled skills into `.agent-crm-dev/claude/skills`
- starts the Electron app with `CLAUDE_CONFIG_DIR=.agent-crm-dev/claude`

The wrapper runs:

```sh
npm --prefix <agent-crm-repo> run -s dev --workspace @agent-crm/cli -- "$@"
```

so the app terminal sees local CLI changes without `npm link` or a global
install. The embedded Claude Code CLI sees local skills through the temporary
`CLAUDE_CONFIG_DIR`, not `~/.claude/skills`. The seed step copies only small
preference files such as `settings.json`, `settings.local.json`, and `commands`;
it does not clone large Claude history/project/cache directories.

## Common Modes

Use local app + production sync engine:

```sh
make app-dev SYNC=prod
```

This still launches the local Electron app and still uses local Claude Code
skills. Only the sync engine URL changes.

Use a custom sync engine URL:

```sh
make app-dev SYNC_URL=http://localhost:9000
SYNC_URL=http://localhost:9000 npm run dev:app
```

Use a different local sync port:

```sh
make app-dev PORT=9000
```

Disable temporary local Claude Code skills:

```sh
make app-dev CLAUDE_SKILLS=off
```

Install local bundled skills into an extra agent, such as Codex:

```sh
make app-dev SKILLS=codex
```

The embedded Claude Code path does not require `SKILLS=claude-code`; it is local
by default and does not touch your global Agent CRM skills lockfile.

## Notes

The launcher does not switch branches. Keep `agent-crm-app` and
`agent-crm-sync-engine` on whichever branch you want to test, usually `main`.
It prints a warning when either sibling repo is not on `main` or is behind its
upstream branch.

For faster restarts when you have not touched sync-engine code:

```sh
make app-dev SKIP_SYNC_BUILD=1
```
