---
"@agent-crm/sdk": major
"@agent-crm/cli": major
---

Move Agent CRM workspaces from the Lix/DataFusion local backend to Postgres-compatible providers.

The SDK now opens Postgres connection strings or injected database handles, exposes a Postgres-backed database abstraction, and initializes the EAV schema with Postgres DDL/jsonb columns. The CLI now targets `ACRM_DATABASE_URL`, `NEON_DATABASE_URL`, `SUPABASE_DATABASE_URL`, `DATABASE_URL`, or `-w <postgres-url>`, stores hosted sync metadata in `acrm_metadata`, and updates SQL/help/skill guidance for Postgres-compatible providers.
