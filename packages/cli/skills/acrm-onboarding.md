---
name: acrm-onboarding
description: Onboard a new Agent CRM user — initialize a `.acrm` workspace (if needed), then walk them through picking a first data source (Gmail / LinkedIn sync / CSV / LinkedIn or X profile) and importing it. Trigger phrasings — "onboard me", "set up agent crm", "get started with acrm", "I'm new to acrm", or a bare `/acrm-onboarding`.
---

# acrm-onboarding

The first-run flow for Agent CRM. Goal: in one conversation, take a user from "nothing" to "populated `.acrm` with their real contacts" so the rest of the skills have something to chew on.

## Run

### 1. Greet + workspace check

Say:

> Welcome to Agent CRM — the headless CRM for Claude. Let's get you set up.

Check whether a workspace already exists in this directory:

```sh
acrm execute "SELECT 1" --json
```

- If that succeeds, you're already inside a workspace — skip to step 2.
- If it fails with `ACRM_ERROR_NO_WORKSPACE`, ask the user what to name their workspace (default: `pipeline.acrm`) and run:

  ```sh
  acrm init <name>.acrm
  ```

### 2. Pick a data source

Use `AskUserQuestion` with this exact question and options (single-select, multipleChoice off):

- **Question**: `What data source do you want to plug into?`
- **Options**:
  1. `Sync from Gmail` — connects Gmail through Agent CRM's hosted sync engine
  2. `Sync from LinkedIn` — connects LinkedIn through Agent CRM's hosted sync engine
  3. `Import a leads CSV` — load a file of leads
  4. `Import a LinkedIn or X profile` — add one person at a time from a profile URL

### 3. Run the branch they chose

#### 3a. Gmail

Powered by Agent CRM's hosted sync engine. Do **not** run a local Gmail
contacts import.

Gmail uses the same hosted Cluster auth gate as LinkedIn. Do not
ask the user for a Cluster org id before starting. The hosted connect page
will infer or create the org from the user's signed-in email domain. Only pass
`--org-id <org-id>` when the user explicitly provides an org id or the
workspace already has one configured.

Before starting OAuth, ask how much Gmail history to import. Use
`AskUserQuestion` with this exact question and options (single-select,
multipleChoice off):

- **Question**: `How much Gmail history should Agent CRM import?`
- **Options**:
  1. `Last 30 days` — quickest backfill for recent conversations
  2. `Last 90 days` — broader backfill for recent pipeline context
  3. `Custom date` — import messages since a specific date

If they choose `Custom date`, ask for a cutoff date in `YYYY-MM-DD` format.
Do not continue until the user provides a valid-looking date.

Then ask whether to filter newsletters and marketing emails. Use
`AskUserQuestion` with this exact question and options (single-select,
multipleChoice off):

- **Question**: `Filter newsletters and marketing emails out of Gmail sync?`
- **Options**:
  1. `Yes, filter them` — recommended for CRM-quality contacts and conversations
  2. `No, include them` — import all matching Gmail history

These choices affect the initial Gmail backfill and future Gmail syncs for
this account.

Run the command with explicit flags:

```sh
acrm --json import gmail --backfill-days 30 --exclude-newsletters
acrm --json import gmail --backfill-days 90 --exclude-newsletters
acrm --json import gmail --backfill-since <YYYY-MM-DD> --exclude-newsletters
```

Use `--include-newsletters` instead of `--exclude-newsletters` when the user
chooses to include newsletters and marketing emails.

This opens the hosted auth flow in the user's default browser. Do not print
`data.auth_url` unless the command fails to open the browser and the user
needs the fallback URL. If you do need to show the fallback URL, print it as a
bare URL on its own line, not as a Markdown link.

```md
Your browser should now be open to connect Gmail.

Pick your Google account and click Allow.

After you finish Google OAuth, Agent CRM's hosted sync engine will start
importing Gmail in the background. The Agent CRM app will then pull
people, threads, and messages into your local `.acrm` workspace.
```

What `acrm import gmail` does now:

1. Reads or creates `.agent-crm-cloud.json` next to the local workspace.
2. Registers the cloud workspace with the hosted sync engine.
3. Opens the hosted Gmail connect page in the user's default browser. That
   page checks Cluster auth, resolves the org from the signed-in email domain,
   then starts Google OAuth.
4. Passes the selected Gmail backfill and newsletter filtering preferences
   to the hosted sync engine.
5. Returns the hosted connect URL as `data.auth_url` for fallback/debugging.

After OAuth, the sync engine redirects to a "Gmail sync started" page and
imports Gmail in the background. Gmail data is written to the cloud
workspace, then the Electron app pulls it into the local `.acrm` file as:

```text
people
communication_threads
communication_messages
```

Do not wait for a local CLI import to finish; there is no local Gmail
import process anymore.

#### 3b. LinkedIn

Use the `connect-linkedin-to-acrm` skill now and follow it end-to-end. Do
not duplicate the LinkedIn connect/import flow in this onboarding skill.

#### 3c. CSV

Ask the user for the path to the CSV. Then run:

```sh
acrm import csv <path>
```

If the user is in another country, pass `--default-country=<ISO>` (e.g. `GB`, `DE`) so locally-formatted phone numbers parse correctly. See `acrm import csv --help` for the full list of recognized column names.

#### 3d. LinkedIn or X profile

Ask the user for the URL (or `@handle` for X). Sniff the platform from the URL and run the right command:

- LinkedIn profile URL (`linkedin.com/in/<slug>`) → `acrm import linkedin '<url>'`
- X / Twitter profile (`x.com/<handle>`, `twitter.com/<handle>`, or bare `@handle`) → `acrm import x '<handle>'`

Both require `APIFY_API_TOKEN` in `.env` next to the workspace. If missing, the CLI prints an exact fix — relay it to the user. After import, offer to add another profile (loop until they're done).

### 4. Confirm + next step

For Gmail, do not add a separate confirmation or next-step message after
the OAuth auth-window copy above.

For local imports, after the import succeeds, show a short summary tied to
what they actually have:

```sh
acrm execute "SELECT object_slug, COUNT(*) AS n FROM acrm_record GROUP BY object_slug" --json
```

Then suggest up to 2 valuable things they can do next, based on what got imported:

1. Recommend finding folks to follow up with (if communications were imported e.g. emails, chats, transcripts)
2. Recommend connecting Granola so meetings flow in: `try /connect-granola-to-acrm`.

Keep the close short - pick the most relevant one or two suggestions, not a feature dump.

## Hard rules

- **Never** fabricate a workspace path or skip the `acrm init` step. If no workspace exists, the user must explicitly name one.
- **Never** silently run a destructive command.
- **Do not use `gws` for Gmail.** Gmail now goes through the hosted sync engine.
- **Don't** fabricate OAuth credentials or paper over auth errors. The user owns the Google consent flow.
- **Don't** loop the AskUserQuestion. Pick one source per onboarding session — if they want to import another source after, they can re-invoke the skill or run the underlying command directly.
