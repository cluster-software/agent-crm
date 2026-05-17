---
"@agent-crm/sdk": patch
---

Reject relative paths in `Workspace.open` and `Workspace.create` so SDK callers must resolve workspace paths explicitly before opening or creating `.acrm` files.
