# @agent-crm/cli

## 0.0.7

### Patch Changes

- 12f315e: Improve `acrm import csv` reliability and discoverability:

  - People can now be identified by LinkedIn URL or Twitter/X URL in addition to email. Dedup
    priority is email → LinkedIn → Twitter. URLs are normalized
    (protocol/www/query/fragment/trailing-slash stripped, twitter.com unified to x.com, bare
    handles like `@foo` accepted).
  - Companies without a domain or email are now deduplicated by case-insensitive name instead
    of being skipped or duplicated.
  - CSV header parsing now collapses whitespace to underscores, so headers like `Company Name`
    work the same as `company_name`.
  - Person name resolution accepts more aliases: `who`, `contact`, `contact_name` (in addition
    to `name`, `full_name`, `person_name`, and `first_name` + `last_name`).
  - When an import produces zero records, diagnostic warnings explain why (e.g. no recognized
    person/company identifier columns).
  - The UI is now spawned as a detached background process after import so the import command
    returns immediately. The JSON response includes a `ui: { pid, url, stop }` handle so callers
    can find and terminate the background server (`stop` is a ready-to-paste `kill <pid>`
    command).
  - `acrm --version` now reads from `package.json` instead of being hardcoded.
