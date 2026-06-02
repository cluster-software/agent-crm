---
"@agent-crm/cli": major
"@agent-crm/sdk": major
---

Remove the raw SQL execution surface. The CLI no longer registers `acrm execute`, bundled skills no longer instruct agents to run raw SQL, and the SDK no longer exports raw query helpers, `Workspace.db`, or wildcard subpaths for private database modules.
