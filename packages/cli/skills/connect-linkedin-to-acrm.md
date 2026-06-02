---
name: connect-linkedin-to-acrm
description: Connect LinkedIn to an Agent CRM / ACRM workspace through the hosted sync engine, then optionally import existing LinkedIn contacts. Use when the user asks to connect, integrate, hook up, sync, import, or troubleshoot LinkedIn with Agent CRM or ACRM.
---

# connect-linkedin-to-acrm

Use this when the user wants LinkedIn connected to their current Agent CRM workspace or wants to import existing LinkedIn contacts.

## What this does

This is the hosted LinkedIn sync flow:

1. In the desktop app, the CLI uses `ACRM_CLOUD_WORKSPACE_ID`, `ACRM_CLOUD_ORG_ID`, and `ACRM_DESKTOP_SESSION_TOKEN` from the app session. Standalone Postgres workspaces get a cloud workspace binding in `acrm_metadata`.
2. The user opens Agent CRM's hosted LinkedIn connect page.
3. Future LinkedIn messages and contacts sync automatically after connection.
4. The user chooses whether to import existing 1st-degree LinkedIn relations.
5. Existing relations import `people` first, start hosted message-history backfill, then enrich structured company records from LinkedIn profile URLs.

## Run

First resolve the workspace. If `ACRM_DESKTOP_SESSION_TOKEN` is present, do not ask for a Postgres URL and do not print the token. Otherwise prefer `ACRM_DATABASE_URL`, `NEON_DATABASE_URL`, `SUPABASE_DATABASE_URL`, or `DATABASE_URL` from the current shell or `.env` in the current project directory. If the standalone workspace is unclear, ask the user for a Postgres-compatible connection string or have them set:

```sh
export ACRM_DATABASE_URL='postgres://...'
```

If the database has not been initialized, run:

```sh
acrm init
```

Run commands from the project directory that contains `.env` and local signal/cache files. If you must target a different database, pass the URL directly with `-w '<postgres-url>'`.

Do not set or re-export a `WORKSPACE` shell variable. Tool calls usually run in fresh shells, so repeated exports add noise without preserving useful state.

Start the connect flow. If the workspace is already connected, this command
returns `data.connected: true` instead of an `auth_url`.

```sh
CONNECT_JSON=$(acrm --json connect linkedin)
echo "$CONNECT_JSON"
if echo "$CONNECT_JSON" | jq -e '.data.connected == true' >/dev/null; then
  exit 0
fi
AUTH_URL=$(echo "$CONNECT_JSON" | jq -r '.data.auth_url')
if command -v open >/dev/null 2>&1; then
  open "$AUTH_URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$AUTH_URL"
else
  echo "$AUTH_URL"
fi
```

Have the user finish LinkedIn verification in the default browser. In desktop sessions, Agent CRM passes a one-time browser handoff so the hosted page skips sign-in. Standalone sessions may still ask the user to sign in first. LinkedIn may ask for an email, SMS, authenticator-app code, or in-app sign-in approval.

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

These options affect existing contacts only; future contacts and messages sync either way.

If they choose `No existing contacts`, stop after confirming LinkedIn is connected.

If they choose `All existing contacts`, run:

```sh
acrm --json import linkedin
```

If they choose `Recent connections`, ask for a cutoff date. Default to 30 days ago, but accept any `YYYY-MM-DD` date the user chooses. Then run:

```sh
acrm --json import linkedin --cutoff-date <YYYY-MM-DD>
```

Run either import command with the Bash tool in the background
(`run_in_background=true`) and monitor output with `BashOutput` instead of
blocking the conversation. If the import fails because LinkedIn is not
connected, stop the background command and send the user back to the connect
flow above.

Existing people are written first. Message-history backfill then starts in the
hosted engine for the imported people without blocking people import. For a few hundred contacts, the final JSON can still
take another 1-2 minutes while company LinkedIn URLs fill in; do not cancel it
just because the people already appeared.

If `acrm import linkedin` says LinkedIn is not connected, send the user back to the connect flow above.

## Message sync note

Do not run `acrm --json import linkedin --sync` in the normal connect/import
flow. Future LinkedIn messages and contacts sync automatically. Use `--sync`
only for debugging or importing already-stored hosted message history into the
Postgres workspace. Run it only when the user explicitly asks to pull messages
or when a first-class message import workflow requires the hosted history to be
materialized locally. In that case, run `--sync` for the resolved workspace by
default; it imports stored messages for every active LinkedIn account enabled
for that workspace, not just the most recently connected profile. Check
`communication_messages_seen` / `communication_messages_created` before
claiming messages were imported.

If `--sync` returns zero messages, do not assume history is still backfilling.
Run `acrm --json connect linkedin --status` and inspect `data.linkedin.sync`.
If `sync.state` is `failed`, report that hosted message backfill failed and
include `sync.errorMessage`. If the state is `pending` or `running`, say it is
still backfilling and try again later.

## Hard rules

- Do not fabricate an org id.
- Never print `ACRM_DESKTOP_SESSION_TOKEN`.
- Do not ask for or store the user's LinkedIn password in chat.
- Do not use Gmail commands for this flow.
- If `acrm` is missing, tell the user to install it with `npm i -g @agent-crm/cli`.
