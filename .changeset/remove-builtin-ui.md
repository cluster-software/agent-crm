---
"@agent-crm/cli": minor
"@agent-crm/sdk": minor
---

Remove the built-in `acrm ui` command and its post-import auto-launch. The
local-server UI shipped with the CLI is superseded by the standalone Electron
app, so the CLI is headless-only now: `acrm import csv` no longer accepts
`--port`, `--no-ui`, or `--no-open`, and no longer spawns a background UI
server on success. The SDK's `ERR.UI` error code is dropped along with the
command.
