---
"@agent-crm/sdk": patch
---

Fix Postgres imports by avoiding oversized normalized-key index entries for long text values and making SDK write operations transactional so failed value inserts do not leave partial record shells.
