---
"@agent-crm/sdk": patch
"@agent-crm/cli": patch
---

Canonicalize Postgres `sslmode=require`/`prefer`/`verify-ca` to `verify-full` before opening node-postgres pools so Neon/Supabase URLs do not emit a misleading SSL warning while preserving current TLS verification behavior.
