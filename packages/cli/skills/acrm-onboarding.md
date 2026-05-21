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
  1. `Sync from Gmail` — pulls Google contacts (My Contacts + everyone you've ever emailed)
  2. `Import a leads CSV` — load a file of leads
  3. `Import a LinkedIn or X profile` — add one person at a time from a profile URL

### 3. Run the branch they chose

#### 3a. Gmail

Powered by the [`gws` CLI](https://github.com/googleworkspace/cli). acrm
ships with its own bundled Google OAuth client, so the user does **not**
need a GCP project, does **not** need `gcloud`, and does **not** need to
touch the Cloud Console. The flow is:

1. Make sure `gws` is installed (one `npm install -g`).
2. Run `acrm import gmail`.
3. A browser opens; user clicks **Allow** to consent to acrm reading their
   Google contacts.
4. Import runs.

##### Preflight

```sh
gws --version       # is the gws CLI installed?
```

##### A — Install `gws` (only if the preflight failed)

```sh
! npm install -g @googleworkspace/cli
```

##### B — Run the import

```sh
! acrm import gmail
```

The CLI handles everything:

1. Writes acrm's bundled OAuth client into `~/.config/gws/client_secret.json`
   on first run (idempotent — leaves an existing file alone).
2. Probes `people.googleapis.com` to see if there's an active session.
3. If not, spawns `gws auth login -s people`, which opens a browser for the
   user to consent.
4. Streams contacts from People API `connections` (the user's curated
   address book) plus `otherContacts` (everyone Google has auto-saved
   because the user emailed them) and upserts them as `people` +
   `companies`, deduped by email and email-domain.

JSON output reports counts:

```json
{
  "ok": true,
  "data": {
    "contacts_seen": 1247,
    "people_created": 932,
    "companies_created": 188,
    "people_skipped_no_identifier": 127,
    "included_other_contacts": true,
    "duration_ms": 18421
  }
}
```

Pass `--no-other-contacts` for "My Contacts only" — skips the auto-saved
bucket.

##### Heads-ups

- **"Google hasn't verified this app"** — until acrm completes Google's
  OAuth verification, the consent screen shows this warning. Tell the user
  to click **Continue → Allow**. One-time click; once we're verified, the
  warning disappears.
- **Bring-your-own OAuth client** — power users who'd rather use their own
  GCP project can set `ACRM_GOOGLE_CLIENT_ID` + `ACRM_GOOGLE_CLIENT_SECRET`
  in the environment. acrm uses those instead of the bundled credentials.

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

After the import succeeds, show a short summary tied to what they actually have:

```sh
acrm execute "SELECT object_slug, COUNT(*) AS n FROM acrm_record GROUP BY object_slug" --json
```

Then suggest the next concrete thing they can do, based on what got imported:

- If `people` > 0 with at least one having a `linkedin_url`, suggest: `try /prep-call <name>` — pulls their LinkedIn and drafts discovery questions.
- Recommend connecting a transcript provider so meetings flow in: `try /setup-transcripts` (enables `/post-call`).

Keep the close short — one or two suggestions, not a feature dump.

## Hard rules

- **Never** fabricate a workspace path or skip the `acrm init` step. If no workspace exists, the user must explicitly name one.
- **Never** silently run a destructive command. `acrm import gmail` is additive (idempotent upsert), so it's safe to re-run — say so if the user worries about duplicates.
- **Don't** fabricate OAuth credentials or paper over auth errors. If `acrm import gmail` fails on OAuth, surface its exact `hint` field to the user — they own the consent flow.
- **Don't** loop the AskUserQuestion. Pick one source per onboarding session — if they want to import another source after, they can re-invoke the skill or run the underlying command directly.
