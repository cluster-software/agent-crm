---
"@agent-crm/sdk": patch
"@agent-crm/cli": patch
---

Fix Postgres imports by avoiding oversized normalized-key index entries for long text values and making SDK write operations transactional so failed value inserts do not leave partial record shells.

Honor direct SDK Postgres connection strings with `channel_binding=require`, and update the records dedupe help text to match its transactional behavior.
