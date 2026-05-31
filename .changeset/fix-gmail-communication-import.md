---
"@agent-crm/sdk": patch
---

Fix Postgres imports by avoiding oversized normalized-key index entries for long text values and making Gmail and LinkedIn import writes transactional.
