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
3. The sync engine can receive post-connection LinkedIn message events from Unipile.
4. The user chooses whether to import existing 1st-degree LinkedIn relations.
5. Existing relations import as lightweight `people` records without bulk profile enrichment.

## Run

First confirm the workspace path. If the user did not provide one, use the current directory and run:

```sh
find . -maxdepth 2 -name '*.acrm' -print
```

If no workspace is found, ask which `.acrm` file to use or initialize one:

```sh
acrm init workspace.acrm
```

Set the workspace path:

```sh
export WORKSPACE=/path/to/workspace.acrm
```

Start the connect flow:

```sh
CONNECT_JSON=$(acrm --json -w "$WORKSPACE" connect linkedin)
echo "$CONNECT_JSON"
open "$(echo "$CONNECT_JSON" | jq -r '.data.auth_url')"
```

Have the user finish Cluster auth and LinkedIn verification in the browser. If they belong to multiple Cluster organizations, the hosted page will ask which one to use. LinkedIn may ask for an email, SMS, or authenticator-app code.

## Choose import behavior

After the browser flow completes, use `AskUserQuestion` with this exact question and options (single-select, multipleChoice off):

- **Question**: `How should Agent CRM import LinkedIn contacts?`
- **Options**:
  1. `Future messages only` — do not import existing contacts; only new message sync creates people later
  2. `All existing contacts` — import all current 1st-degree LinkedIn connections
  3. `Recent connections` — import connections after a cutoff date

If they choose `Future messages only`, stop after confirming LinkedIn is connected.

If they choose `All existing contacts`, run:

```sh
acrm --json -w "$WORKSPACE" import linkedin
```

If they choose `Recent connections`, ask for a cutoff date. Default to 30 days ago, but accept any `YYYY-MM-DD` date the user chooses. Then run:

```sh
acrm --json -w "$WORKSPACE" import linkedin --cutoff-date <YYYY-MM-DD>
```

If `acrm import linkedin` says LinkedIn is not connected, send the user back to the connect flow above.

## Sync messages

After the browser flow completes, pull any available LinkedIn messages:

```sh
acrm --json -w "$WORKSPACE" import linkedin --sync
```

Verify recent imported message bodies:

```sh
acrm --json -w "$WORKSPACE" execute "
SELECT value_json, active_from
FROM acrm_value
WHERE object_slug = 'communication_messages'
  AND attribute_slug = 'body_text'
  AND active_until IS NULL
ORDER BY active_from DESC
LIMIT 5
"
```

## Hard rules

- Do not fabricate a Cluster org id.
- Do not ask for or store the user's LinkedIn password in chat.
- Do not use Gmail commands for this flow.
- If `acrm` is missing, tell the user to install it with `npm i -g @agent-crm/cli`.
