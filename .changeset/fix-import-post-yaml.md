---
"@agent-crm/cli": patch
---

Fix `import-post` SKILL.md: the description contained `Phrasings:` mid-string,
which YAML parses as a nested mapping key. Codex enforces YAML strictly and
was skipping the skill with `mapping values are not allowed in this context`.
Replace the colon with an em dash so the frontmatter parses everywhere.
