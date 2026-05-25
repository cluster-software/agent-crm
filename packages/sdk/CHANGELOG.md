# @agent-crm/sdk

## 0.6.2

### Patch Changes

- ee70bee: Import companies and person-company links from hosted communication batches.

## 0.6.1

### Patch Changes

- 1cb8365: Batch communication imports so hosted Gmail sync writes people, threads, messages, and relationships without one Lix commit per field.

## 0.6.0

### Minor Changes

- 8d6f2c6: Add local communication import support for hosted Gmail sync.

## 0.5.1

### Patch Changes

- ad40254: Add local multi-output signals with CLI commands, import-time background runs, per-field provenance, and a hotel contact-path example.

## 0.5.0

### Minor Changes

- 2e01271: Add `/acrm-onboarding` skill and `acrm import gmail` command.

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

## 0.4.0

### Minor Changes

- 527963a: `acrm import csv` now treats phone numbers as a first-class person identifier.
  Address-book exports (macOS Contacts, Google Contacts, iCloud) that carry
  phone-only rows used to be silently dropped — fixes #84, where 931 of 1112
  contacts in one user's import never landed.

  - Recognized headers: `phone | mobile | cell | telephone | tel`, with
    optional `_number` suffix, optional `_N` index, and optional `work_` /
    `personal_` / `home_` / `mobile_` / `cell_` / `primary_` / `business_` /
    `other_` prefix. Multiple numbers per column are split on `,` or `;`.
  - Dedup cascade is now: email → linkedin → twitter → **phone**. Phones are
    parsed to E.164 via `libphonenumber-js`, so `(415) 555-1234`,
    `1-415-555-1234`, and `+1 (415) 555-1234` all dedupe to `+14155551234`.
  - New `--default-country <iso>` flag on `acrm import csv` (defaults to
    `US`) controls how locally-formatted numbers are parsed. Numbers that
    already include a `+<dial-code>` prefix are parsed independent of the
    default. Pass `--default-country=GB` (etc.) when importing contacts
    from another locale.
  - New schema attribute `people.phone_numbers` (multivalued + unique,
    type `phone-number`). New workspaces get it via `acrm init`; existing
    `.acrm` files will pick it up the next time you create a new workspace.
  - The SDK gains a new `phone-number` `AttributeType`, a
    `normalizePhoneNumber(input, defaultCountry?)` helper backed by
    `libphonenumber-js/min`, and `phones` / `phone` fields on
    `PersonIdentifiers`. `resolvePersonByIdentifiers` / `normalizeIdentifiers`
    now accept `{ default_country }` so the cascade is shared between
    `acrm import csv` and `acrm import transcript`.

## 0.3.0

### Minor Changes

- 5014031: Remove the built-in `acrm ui` command and its post-import auto-launch. The
  local-server UI shipped with the CLI is superseded by the standalone Electron
  app, so the CLI is headless-only now: `acrm import csv` no longer accepts
  `--port`, `--no-ui`, or `--no-open`, and no longer spawns a background UI
  server on success. The SDK's `ERR.UI` error code is dropped along with the
  command.

## 0.2.0

### Minor Changes

- 4e0255d: Consolidate SDK workspace lifecycle around `Workspace.create()` and
  `Workspace.open()`, removing the functional lifecycle helpers from the public
  API. Update CLI initialization to use the canonical workspace API.

## 0.1.3

### Patch Changes

- 03bf969: Update the npm package descriptions.

## 0.1.2

### Patch Changes

- 99a3bbe: Reject relative paths in `Workspace.open` and `Workspace.create` so SDK callers must resolve workspace paths explicitly before opening or creating `.acrm` files.

## 0.1.1

### Patch Changes

- d716d14: Verify the CI `NPM_TOKEN` has rights to publish both `@agent-crm/sdk` and
  `@agent-crm/cli` after the granular-token allowlist fix. Adds a SDK
  README and bumps both packages by a patch to exercise the full
  changesets → publish pipeline.

## 0.1.0

### Minor Changes

- bf2c0a8: Carve `@agent-crm/sdk` out of `@agent-crm/cli`. The repo is now an npm
  workspace with two published packages:

  - **`@agent-crm/sdk`** — programmatic API: `Workspace`, the per-operation
    functions (`importTranscript`, `importCsv`, `dedupeRecords`, …), the
    domain helpers (`encode`, `normalizeIdentifiers`, …), the integration
    adapters (Granola, Apify, MCP), and the EAV schemas. Takes structured
    inputs, returns structured results, never touches `process.argv` /
    `cwd` / `exit` / `stdout` / `stderr` / `stdin` / `env`.

  - **`@agent-crm/cli`** — the `acrm` command-line tool. Now a thin
    argv-and-output adapter on top of the SDK. Public command surface
    (flags, positional args, JSON output shape) is byte-identical to
    prior releases. Depends on `@agent-crm/sdk` for everything except
    commander wiring, stdout/stderr formatting, the local UI server
    (`acrm ui`), the OAuth callback flow (`acrm auth <provider>`), the
    CSV-import progress bar, and skills installation.

  Refs #64.
