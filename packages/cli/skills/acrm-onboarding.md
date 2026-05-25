---
name: acrm-onboarding
description: Onboard a new Agent CRM user — initialize a `.acrm` workspace (if needed), then walk them through picking a first data source (Gmail / CSV / LinkedIn or X profile) and importing it. Trigger phrasings — "onboard me", "set up agent crm", "get started with acrm", "I'm new to acrm", or a bare `/acrm-onboarding`.
---

# acrm-onboarding

The first-run flow for Agent CRM. Goal: in one conversation, take a user from "nothing" to "populated `.acrm` with their real contacts" so the rest of the skills (`/prep-call`, `/follow-up`, `/post-call`) have something to chew on.

## Run

### 1. Greet + workspace check

Say:

> Welcome to Agent CRM — the headless CRM for Claude. Let's get you set up.

Then check whether a workspace already exists in this directory:

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
  2. `Import a leads CSV` — load a file of leads
  3. `Import a LinkedIn or X profile` — add one person at a time from a profile URL

### 3. Run the branch they chose

#### 3a. Gmail

Powered by Agent CRM's hosted sync engine. Do **not** run a local Gmail
contacts import.

Run:

```sh
acrm import gmail --json
```

Extract `data.auth_url` from the JSON response and show it to the user as
a clickable link. Tell the user to open the URL, choose their Google
account, and click Allow.

What `acrm import gmail` does now:

1. Reads or creates `.agent-crm-cloud.json` next to the local workspace.
2. Starts a hosted sync-engine OAuth attempt.
3. Returns the Google OAuth URL immediately.

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

#### 3b. CSV

Ask the user for the path to the CSV. Then run:

```sh
acrm import csv <path>
```

If the user is in another country, pass `--default-country=<ISO>` (e.g. `GB`, `DE`) so locally-formatted phone numbers parse correctly. See `acrm import csv --help` for the full list of recognized column names.

#### 3c. LinkedIn or X profile

Ask the user for the URL (or `@handle` for X). Sniff the platform from the URL and run the right command:

- LinkedIn profile URL (`linkedin.com/in/<slug>`) → `acrm import linkedin '<url>'`
- X / Twitter profile (`x.com/<handle>`, `twitter.com/<handle>`, or bare `@handle`) → `acrm import x '<handle>'`

Both require `APIFY_API_TOKEN` in `.env` next to the workspace. If missing, the CLI prints an exact fix — relay it to the user. After import, offer to add another profile (loop until they're done).

### 4. Confirm + next step

For Gmail, tell the user:

> Gmail sync has started. It runs in the background and will keep updating
> through Agent CRM's hosted sync engine.

For local imports, after the import succeeds, show a short summary tied to
what they actually have:

```sh
acrm execute "SELECT object_slug, COUNT(*) AS n FROM acrm_record GROUP BY object_slug" --json
```

Then suggest the next concrete thing they can do, based on what got imported:

- If `people` > 0 with at least one having a `linkedin_url`, suggest: `try /prep-call <name>` — pulls their LinkedIn and drafts discovery questions.
- Recommend connecting a transcript provider so meetings flow in: `try /setup-transcripts` (enables `/post-call`).

Keep the close short — one or two suggestions, not a feature dump.

## Hard rules

- **Never** fabricate a workspace path or skip the `acrm init` step. If no workspace exists, the user must explicitly name one.
- **Never** silently run a destructive command.
- **Do not use `gws` for Gmail.** Gmail now goes through the hosted sync engine.
- **Don't** fabricate OAuth credentials or paper over auth errors. The user owns the Google consent flow.
- **Don't** loop the AskUserQuestion. Pick one source per onboarding session — if they want to import another source after, they can re-invoke the skill or run the underlying command directly.
