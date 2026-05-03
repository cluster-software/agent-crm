# Schema

Agent CRM ports the [Attio](https://docs.attio.com/docs/standard-objects) data model 1:1 — five standard objects plus Notes and Tasks as first-class resources.

## Standard objects

| Object       | Slug          | Default?    | Purpose                            |
| ------------ | ------------- | ----------- | ---------------------------------- |
| Companies    | `companies`   | enabled     | Organizations / accounts           |
| People       | `people`      | enabled     | Individual contacts                |
| Deals        | `deals`       | activatable | Sales opportunities                |
| Workspaces   | `workspaces`  | activatable | Customer workspaces (B2B SaaS)     |
| Users        | `users`       | activatable | End-users of your product          |

Plus two activity resources (not objects): **Notes** and **Tasks**.

## System fields

Every record carries:

| Field                | Type        | Notes                                              |
| -------------------- | ----------- | -------------------------------------------------- |
| `id.workspace_id`    | uuid        | Workspace the record belongs to                    |
| `id.object_id`       | uuid        | Object the record belongs to                       |
| `id.record_id`       | uuid        | The record's own id                                |
| `created_at`         | timestamp   | ISO 8601 UTC, nanosecond precision                 |
| `web_url`            | text        | Direct link to the record in the UI                |
| `values`             | object      | Attribute data, keyed by slug, each as an array of value objects |

Each value object inside `values[slug]` carries `active_from`, `active_until`, `created_by_actor`, and `attribute_type`. There is no top-level `updated_at` or `created_by` on records — change tracking lives per-value.

---

## `companies`

Organizations. Enabled by default. Auto-enriched.

| Attribute              | Slug                    | Type                   | Multi | Unique |
| ---------------------- | ----------------------- | ---------------------- | ----- | ------ |
| Domains                | `domains`               | `domain`               | ✓     | ✓      |
| Name                   | `name`                  | `text`                 |       |        |
| Description            | `description`           | `text`                 |       |        |
| Team                   | `team`                  | → `people`             | ✓     |        |
| Categories             | `categories`            | `select`               | ✓     |        |
| Primary location       | `primary_location`      | `location`             |       |        |
| AngelList              | `angellist`             | `text`                 |       |        |
| Facebook               | `facebook`              | `text`                 |       |        |
| Instagram              | `instagram`             | `text`                 |       |        |
| LinkedIn               | `linkedin`              | `text`                 |       |        |
| Twitter                | `twitter`               | `text`                 |       |        |
| Associated deals       | `associated_deals`      | → `deals`              | ✓     |        |
| Associated workspaces  | `associated_workspaces` | → `workspaces`         | ✓     |        |

Companies are auto-enriched with read-only attributes (employee count, founded date, logo URL, follower counts, etc.) and `interaction`-typed system attributes (`first_email_interaction`, `last_email_interaction`, `first_calendar_interaction`, `last_calendar_interaction`, `next_calendar_interaction`).

---

## `people`

Individual contacts. Enabled by default. Auto-enriched.

| Attribute           | Slug                | Type                   | Multi | Unique |
| ------------------- | ------------------- | ---------------------- | ----- | ------ |
| Email addresses     | `email_addresses`   | `email-address`        | ✓     | ✓      |
| Name                | `name`              | `personal-name`        |       |        |
| Company             | `company`           | → `companies`          |       |        |
| Description         | `description`       | `text`                 |       |        |
| Job title           | `job_title`         | `text`                 |       |        |
| Phone numbers       | `phone_numbers`     | `phone-number`         | ✓     |        |
| Primary location    | `primary_location`  | `location`             |       |        |
| AngelList           | `angellist`         | `text`                 |       |        |
| Facebook            | `facebook`          | `text`                 |       |        |
| Instagram           | `instagram`         | `text`                 |       |        |
| LinkedIn            | `linkedin`          | `text`                 |       |        |
| Twitter             | `twitter`           | `text`                 |       |        |
| Associated deals    | `associated_deals`  | → `deals`              | ✓     |        |
| Associated users    | `associated_users`  | → `users`              | ✓     |        |

People carry the same set of enriched read-only attributes and `interaction`-typed timestamps as Companies.

---

## `deals`

Sales opportunities. Activatable.

| Attribute           | Slug                  | Type                   | Multi | Unique | Required |
| ------------------- | --------------------- | ---------------------- | ----- | ------ | -------- |
| Name                | `name`                | `text`                 |       |        | ✓        |
| Deal stage          | `stage`               | `status`               |       |        | ✓        |
| Deal owner          | `owner`               | `actor-reference`      |       |        | ✓        |
| Deal value          | `value`               | `currency`             |       |        |          |
| Associated people   | `associated_people`   | → `people`             | ✓     |        |          |
| Associated company  | `associated_company`  | → `companies`          |       |        |          |

Default stage options: **Lead**, **In Progress**, **Won 🎉**, **Lost**. `stage` is the only system instance of the `status` type. Deals have no unique attribute by default — add a custom unique attribute to enable upserts.

---

## `workspaces`

Customer workspaces (for B2B SaaS modeling end-customer accounts). Activatable.

| Attribute   | Slug            | Type                   | Multi | Unique |
| ----------- | --------------- | ---------------------- | ----- | ------ |
| ID          | `workspace_id`  | `text`                 |       | ✓      |
| Name        | `name`          | `text`                 |       |        |
| Users       | `users`         | → `users`              | ✓     |        |
| Company     | `company`       | → `companies`          |       |        |
| Avatar URL  | `avatar_url`    | `text`                 |       |        |

---

## `users`

End-users of your product. Activatable.

| Attribute              | Slug                     | Type                   | Multi | Unique |
| ---------------------- | ------------------------ | ---------------------- | ----- | ------ |
| Person                 | `person`                 | → `people`             |       |        |
| Primary email address  | `primary_email_address`  | `text`                 |       | ✓      |
| ID                     | `user_id`                | `text`                 |       | ✓      |
| Workspaces             | `workspace`              | → `workspaces`         | ✓     |        |

Users have two unique attributes — either can be used to assert.

---

## `notes` (resource)

Free-form content attached to any record. Not an object — has its own endpoints.

| Field               | Type                  | Notes                                              |
| ------------------- | --------------------- | -------------------------------------------------- |
| `id.workspace_id`   | uuid                  |                                                    |
| `id.note_id`        | uuid                  |                                                    |
| `parent_object`     | text (slug or uuid)   | The object the note attaches to                    |
| `parent_record_id`  | uuid                  | The record the note attaches to                    |
| `title`             | text                  | Plaintext only                                     |
| `format`            | enum                  | `plaintext` \| `markdown` (write-side)             |
| `content`           | text                  | Write-side; format per `format`                    |
| `content_plaintext` | text                  | Read-side                                          |
| `content_markdown`  | text                  | Read-side                                          |
| `tags`              | array                 | @-mentioned workspace members or records           |
| `meeting_id`        | uuid \| null          | Optional meeting link                              |
| `created_by_actor`  | actor-reference       | `{ type, id }`                                     |
| `created_at`        | timestamp             | Backdate-able on create                            |

Markdown subset: H1–H3, ordered/unordered lists, bold/italic/strikethrough/highlight, links.

---

## `tasks` (resource)

To-dos linked to records and assigned to workspace members. Not an object.

| Field               | Type                  | Notes                                              |
| ------------------- | --------------------- | -------------------------------------------------- |
| `id.workspace_id`   | uuid                  |                                                    |
| `id.task_id`        | uuid                  |                                                    |
| `content`           | text (≤ 2000 chars)   | Plaintext only — no record-reference formatting   |
| `format`            | enum                  | Must be `plaintext`                                |
| `content_plaintext` | text                  | Read-side                                          |
| `deadline_at`       | timestamp \| null     | ISO 8601                                           |
| `is_completed`      | boolean               |                                                    |
| `completed_at`      | timestamp \| null     | When marked complete                               |
| `linked_records`    | array                 | `[{ target_object_id, target_record_id }]`         |
| `assignees`         | array                 | `[{ referenced_actor_type, referenced_actor_id }]` (workspace members only) |
| `created_by_actor`  | actor-reference       |                                                    |
| `created_at`        | timestamp             |                                                    |

---

## Attribute types

Attio defines 17 attribute types.

| Type                | Sub-fields / shape                                                              | Multi-capable | Unique-capable | Notes                                        |
| ------------------- | ------------------------------------------------------------------------------- | ------------- | -------------- | -------------------------------------------- |
| `text`              | `value` (string, ≤ 10MB)                                                        |               | ✓              | Generic unstructured text                    |
| `personal-name`     | `first_name`, `last_name`, `full_name`                                          |               |                | System type — only on `people.name`          |
| `email-address`     | `email_address`, `original_email_address`, `email_domain`, `email_root_domain`, `email_local_specifier` | ✓ | ✓     | Auto-normalized                              |
| `domain`            | `domain`, `root_domain`                                                         | ✓             | ✓              | System type — only on `companies.domains`    |
| `phone-number`      | `original_phone_number`, `normalized_phone_number`, `country_code`              | ✓             |                | E.164, country-code prefixed                 |
| `location`          | `line_1`–`line_4`, `locality`, `region`, `postcode`, `country_code`, `latitude`, `longitude` | |             | Atomic updates — must specify all properties |
| `currency`          | `currency_value`, `currency_code`                                               |               |                | 4 decimals; ISO 4217; code set at attr level |
| `number`            | `value` (float)                                                                 |               |                | Up to 4 decimals                             |
| `date`              | `YYYY-MM-DD`                                                                    |               |                | UTC, time stripped                           |
| `timestamp`         | ISO 8601 UTC, ns precision                                                      |               |                | `created_at` is a built-in instance          |
| `checkbox`          | `value` (boolean)                                                               |               |                | No null state                                |
| `rating`            | `value` (0–5 int)                                                               |               |                | Star rating UI                               |
| `select`            | `{ id, title }` option reference                                                | ✓             |                | Options pre-defined; cannot create on write  |
| `status`            | `{ id, title }` option reference                                                |               |                | Powers kanban; only system instance is `deals.stage` |
| `record-reference`  | `target_object`, `target_record_id`                                             | ✓             |                | Bidirectional; `allowed_object_ids` constrains targets |
| `actor-reference`   | `referenced_actor_type` (`api-token` \| `workspace-member` \| `system`), `referenced_actor_id` | ✓ |        | API can only write workspace-member actors today |
| `interaction`       | `interaction_type` (`email` \| `calendar-event`), `interacted_at`, `owner_actor`, `created_by_actor`, `active_from`, `active_until` | ✓ | | System-only; populated by enrichment/sync   |

---

## Relationships

Bidirectional links — writing one side updates the inverse:

```
Companies  ◄── people.company / companies.team ──►  People
Companies  ◄── deals.associated_company / companies.associated_deals ──►  Deals
People     ◄── deals.associated_people  / people.associated_deals  ──►  Deals
Companies  ◄── workspaces.company / companies.associated_workspaces ──►  Workspaces
Workspaces ◄── users.workspace    / workspaces.users               ──►  Users
People     ◄── users.person       / people.associated_users        ──►  Users
```

Activity resources attach via parent reference (one-way):

```
Notes  ─attaches─►  any record (parent_object + parent_record_id)
Tasks  ─links to─►  any records (linked_records[])
Tasks  ─assigned to─►  workspace members (assignees[])
```
