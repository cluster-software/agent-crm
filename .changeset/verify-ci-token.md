---
"@agent-crm/sdk": patch
"@agent-crm/cli": patch
---

Verify the CI `NPM_TOKEN` has rights to publish both `@agent-crm/sdk` and
`@agent-crm/cli` after the granular-token allowlist fix. Adds a SDK
README and bumps both packages by a patch to exercise the full
changesets → publish pipeline.
