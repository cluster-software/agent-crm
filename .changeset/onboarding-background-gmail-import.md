---
"@agent-crm/cli": patch
---

`acrm-onboarding` skill: instruct Claude to run `acrm import gmail` in the
background via `Bash(run_in_background=true)` and poll `BashOutput`, so the
OAuth URL banner is surfaced *before* the user consents. A foreground Bash
call doesn't return output until the command exits — and `gws auth login`
blocks waiting on the consent callback, so the URL was effectively hidden
until users manually backgrounded the process.
