---
"@agent-crm/cli": minor
"@agent-crm/sdk": minor
---

Remove the built-in `acrm ui` command and its post-import auto-launch. The CLI
is headless-only now: `acrm import csv` no longer accepts `--port`, `--no-ui`,
or `--no-open`, and no longer spawns a background UI server on success. Browse
your `.acrm` with any SQLite client, or via `acrm execute "SELECT ..."`. The
SDK's `ERR.UI` error code is dropped along with the command.
