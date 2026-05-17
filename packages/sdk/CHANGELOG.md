# @agent-crm/sdk

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
