# @agent-crm/sdk

Programmatic API for the [Agent CRM](https://github.com/cluster-software/agent-crm) Postgres workspace — the same operations the [`@agent-crm/cli`](https://www.npmjs.com/package/@agent-crm/cli) `acrm` command runs, but as typed functions you can call in-process.

```ts
import { Workspace, importTranscript } from "@agent-crm/sdk";

const workspace = await Workspace.open();
try {
  const result = await importTranscript(workspace, {
    source: "granola",
    source_id: "meeting-123",
    title: "Discovery — Acme",
    participants: [{ email: "alice@acme.com" }],
  });
  console.log(result.transcript_record_id);
} finally {
  await workspace.close();
}
```

`Workspace.create(url)` and `Workspace.open(url)` connect to a Postgres-compatible
database URL and initialize the built-in schemas, objects, and attributes. You
can also set `ACRM_DATABASE_URL`, `NEON_DATABASE_URL`,
`SUPABASE_DATABASE_URL`, or `DATABASE_URL`. Provider-specific defaults are
selected automatically for Neon and Supabase URLs, or with
`ACRM_DATABASE_PROVIDER=neon|supabase|postgres`.

See the [main README](https://github.com/cluster-software/agent-crm) for an overview of the workspace model, the EAV schema, and the CLI on top of this SDK.
