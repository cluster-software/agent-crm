---
name: connect-granola-to-acrm
description: Connect Granola to an Agent CRM / ACRM workspace through the hosted sync engine using a user-provided Granola API key, then optionally backfill recent transcripts.
---

# Connect Granola to ACRM

Use this skill when the user asks to connect, integrate, sync, import, or
troubleshoot Granola with Agent CRM.

## Steps

1. Confirm the workspace is ready:

   ```sh
   acrm --version
   acrm connect granola --status --json
   ```

2. If Granola is not connected, ask the user for a Granola API key with
   Personal notes and Public notes access.

3. Pipe the key through stdin so it is not echoed as a shell argument:

   ```sh
   printf '%s' "$GRANOLA_API_KEY" | acrm connect granola --api-key-stdin --json
   ```

4. For a recency-limited first import, add:

   ```sh
   --cutoff-date YYYY-MM-DD
   ```

5. Start a backfill/import into the local workspace:

   ```sh
   acrm import granola --json
   ```

   Use the same `--cutoff-date YYYY-MM-DD` when the user requested a recency
   limit.

## Notes

- Granola uses Agent CRM's hosted sync engine and Granola's REST API.
- The sync engine stores the API key encrypted, fetches notes with transcripts,
  creates `people` from participant emails, and links transcripts to those
  people.
- If `acrm import granola` reports that Granola is not connected, rerun the
  connect step and then retry the import.
