---
"@agent-crm/cli": minor
"@agent-crm/sdk": minor
---

Add `/acrm-onboarding` skill and `acrm import gmail` command.

New users can now run `/acrm-onboarding` and pick a data source (Gmail / CSV /
LinkedIn or X profile) to populate a fresh workspace. The Gmail path shells
out to the [`gws` CLI](https://github.com/googleworkspace/cli), pulls People
API `connections` plus auto-created `otherContacts` (every email
correspondent Google has saved), and upserts them as `people` + `companies`
deduped by email and email-domain — matching `acrm import csv` semantics.

acrm ships with its own bundled Google OAuth Desktop client, so the end-user
flow is just `npm install -g @googleworkspace/cli` + `acrm import gmail` →
one browser pop-up to consent → done. No GCP project, no gcloud install, no
Cloud Console clicks. Power users who prefer their own OAuth client can set
`ACRM_GOOGLE_CLIENT_ID` + `ACRM_GOOGLE_CLIENT_SECRET` to override.

- SDK: `importGoogleContacts(workspace, { contacts, default_country? })`
  accepts an iterable of `GoogleContact` and upserts via the existing dedup
  cascade. New `resolveGoogleClientCredentials()` + `buildClientSecretJson()`
  helpers expose the bundled OAuth client (with env-var override).
- CLI: `acrm import gmail [--no-other-contacts] [--default-country <iso>]`.
  Auto-bootstraps `~/.config/gws/client_secret.json` on first run, then
  drives `gws auth login -s people` itself if not authed.
