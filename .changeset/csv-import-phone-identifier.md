---
"@agent-crm/cli": minor
"@agent-crm/sdk": minor
---

`acrm import csv` now treats phone numbers as a first-class person identifier.
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
