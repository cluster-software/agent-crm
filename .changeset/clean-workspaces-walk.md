---
"@agent-crm/sdk": minor
"@agent-crm/cli": patch
---

Consolidate SDK workspace lifecycle around `Workspace.create()` and
`Workspace.open()`, removing the functional lifecycle helpers from the public
API. Update CLI initialization to use the canonical workspace API.
