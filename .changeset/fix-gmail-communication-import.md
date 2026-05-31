---
"@agent-crm/sdk": patch
---

Fix Gmail communication imports against Postgres by avoiding oversized normalized-key index entries for long text values and making the import write transactionally.
