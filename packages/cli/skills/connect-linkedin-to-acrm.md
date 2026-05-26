---
name: connect-linkedin-to-acrm
description: Connect LinkedIn to an Agent CRM / ACRM workspace through the hosted sync engine, then optionally import existing LinkedIn contacts. Use when the user asks to connect, integrate, hook up, sync, import, or troubleshoot LinkedIn with Agent CRM, ACRM, or an `.acrm` workspace.
---

# connect-linkedin-to-acrm

Use this when the user wants LinkedIn connected to their current `.acrm` workspace or wants to import existing LinkedIn contacts.

## What this does

This is the hosted LinkedIn sync flow:

1. The local workspace gets a cloud workspace binding in `.agent-crm-cloud.json`.
2. The user opens Agent CRM's hosted LinkedIn connect page.
3. Future LinkedIn messages and contacts sync automatically after connection.
4. The user chooses whether to import existing 1st-degree LinkedIn relations.
5. Existing relations import as lightweight `people` and `companies` records without bulk profile enrichment.

## Run

First resolve the workspace. Prefer the user's active/open `.acrm` workspace or the current working directory. If the workspace is unclear, run:

```sh
find . -maxdepth 2 -name '*.acrm' -print
```

If no workspace is found, ask which `.acrm` file to use or initialize one:

```sh
acrm init workspace.acrm
```

Run commands from the directory containing the active `.acrm` file and omit `-w` when there is a single obvious workspace. If you must run from a different directory or there are multiple `.acrm` files, pass the absolute path directly with `-w /path/to/workspace.acrm`.

Do not set or re-export a `WORKSPACE` shell variable. Tool calls usually run in fresh shells, so repeated exports add noise without preserving useful state.

Start the connect flow:

```sh
CONNECT_JSON=$(acrm --json connect linkedin)
echo "$CONNECT_JSON"
open "$(echo "$CONNECT_JSON" | jq -r '.data.auth_url')"
```

Have the user finish Cluster auth and LinkedIn verification in the browser. If they belong to multiple Cluster organizations, the hosted page will ask which one to use. LinkedIn may ask for an email, SMS, authenticator-app code, or in-app sign-in approval.

After opening the browser, keep the agent turn active and poll for completion every 2 seconds. Do not surface import options until the status command verifies LinkedIn is connected:

```sh
while true; do
  STATUS_JSON=$(acrm --json connect linkedin --status 2>/dev/null || true)
  if echo "$STATUS_JSON" | jq -e '.ok == true and .data.linkedin.connected == true' >/dev/null; then
    echo "$STATUS_JSON"
    break
  fi
  sleep 2
done
```

## Choose import behavior

After the polling loop verifies completion, use `AskUserQuestion` with this exact question and options (single-select, multipleChoice off):

- **Question**: `Future LinkedIn messages and contacts sync automatically. Import existing contacts now?`
- **Options**:
  1. `No existing contacts` — skip current connections
  2. `All existing contacts` — import every current 1st-degree connection
  3. `Recent connections` — import only after a cutoff date

If they choose `No existing contacts`, stop after confirming LinkedIn is connected.

If they choose `All existing contacts`, run:

```sh
acrm --json import linkedin
```

If they choose `Recent connections`, ask for a cutoff date. Default to 30 days ago, but accept any `YYYY-MM-DD` date the user chooses. Then run:

```sh
acrm --json import linkedin --cutoff-date <YYYY-MM-DD>
```

If `acrm import linkedin` says LinkedIn is not connected, send the user back to the connect flow above.

## Message sync note

Do not run `acrm --json import linkedin --sync` in the normal connect/import
flow. Future LinkedIn messages and contacts sync automatically. Use `--sync`
only for debugging or backfilling already-stored hosted message events, and
check `communication_messages_seen` / `communication_messages_created` before
claiming messages were imported.

## Hard rules

- Do not fabricate a Cluster org id.
- Do not ask for or store the user's LinkedIn password in chat.
- Do not use Gmail commands for this flow.
- If `acrm` is missing, tell the user to install it with `npm i -g @agent-crm/cli`.
