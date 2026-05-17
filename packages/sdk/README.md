# @agent-crm/sdk

Programmatic API for the [Agent CRM](https://github.com/cluster-software/agent-crm) `.acrm` workspace — the same operations the [`@agent-crm/cli`](https://www.npmjs.com/package/@agent-crm/cli) `acrm` command runs, but as typed functions you can call in-process.

```ts
import { openWorkspace, importTranscript } from "@agent-crm/sdk";

const workspace = await openWorkspace("/path/to/file.acrm");
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

See the [main README](https://github.com/cluster-software/agent-crm) for an overview of the workspace model, the EAV schema, and the CLI on top of this SDK.
