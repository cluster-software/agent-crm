<div align="center">

```txt
   █████╗  ██████╗ ███████╗███╗   ██╗████████╗     ██████╗██████╗ ███╗   ███╗
  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝    ██╔════╝██╔══██╗████╗ ████║
  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║       ██║     ██████╔╝██╔████╔██║
  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║       ██║     ██╔══██╗██║╚██╔╝██║
  ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║       ╚██████╗██║  ██║██║ ╚═╝ ██║
  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝        ╚═════╝╚═╝  ╚═╝╚═╝     ╚═╝
```

## The headless crm for claude code

</div>

```txt
                    ┌──────────────┐
                    │  Custom UIs  │
                    └──────┬───────┘
                           │
┌────────────┐      ┌──────▼──────┐      ┌───────────────┐
│ AI Agents  ├─────►│  .acrm      │◄─────┤ CLI / Scripts │
└────────────┘      └─────────────┘      └───────────────┘
```

## Why Agent CRM
- **🧩 Headless:** no UI. Ships as a CLI.
- **⚒️ Skills based:** Claude writes skills against the CLI (transcript ingestion, stale-deal sweeps, weekly reports) as `.md` files.
- **🧱 Modeled:** a CRM data model out of the box: `companies`, `people`, `deals`, `activities`. Typed, related, queryable with plain SQL. Fixed schema = predictable agent edits.
- **🔀 Version controlled:** every change is a checkpoint on a branch. Diff, merge, revert, time-travel.


## Claude writes your GTM skills

Because the CLI is open and the file lives next to your code, **Claude Code can author its own automations as skills** — no plugin marketplace, no integration vendor, no waiting on a roadmap.

> _"Write me a skill that runs every Monday, reads my call transcripts, updates deal stages, and posts a summary to Slack."_

Claude writes the skill, drops it in `.claude/skills/`, and runs it on a branch first so you can review.

#### Example: a `weekly-pipeline-review` skill Claude wrote in 30 seconds

```bash
# .claude/skills/weekly-pipeline-review.sh
#!/usr/bin/env bash
set -euo pipefail

acrm log ./pipeline.acrm --since 7d --json | jq '{
  netARR:   .deltaARR,
  wins:     [.checkpoints[] | select(contains("Closed-Won"))],
  slips:    [.checkpoints[] | select(contains("close_date"))],
  newDeals: [.checkpoints[] | select(startswith("add deal"))]
}'
```

## Quickstart

Install the CLI:

```bash
npm install -g @agent-crm/cli
```

Create your first workspace:

```bash
acrm init                              # creates .acrm workspace
claude --dangerously-skip-permissions  # let claude rip
```

## Schema

Agent CRM ships with four standard objects

#### `companies` — businesses you sell to, partner with, or track

| Attribute              | Type            |
| ---------------------- | --------------- |
| `record_id`            | uuid (pk)       |
| `domains`              | domain[]        |
| `name`                 | text            |
| `description`          | text            |
| `categories`           | select[]        |
| `primary_location`     | location        |
| `linkedin`             | text            |
| `associated_deals`     | → `deals`[]     |
| `associated_people`    | → `people`[]    |

#### `people` — humans at those companies

| Attribute           | Type          |
| ------------------- | ------------- |
| `record_id`         | uuid (pk)     |
| `email_addresses`   | email[] (unique) |
| `name`              | personal_name |
| `company`           | → `companies` |
| `job_title`         | text          |
| `phone_numbers`     | phone[]       |
| `primary_location`  | location      |
| `linkedin`          | text          |
| `twitter_x`         | text          |
| `lifecycle_stage`   | text          |
| `associated_deals`  | → `deals`[]   |

#### `deals` — sales opportunities

| Attribute            | Type                  |
| -------------------- | --------------------- |
| `record_id`          | uuid (pk)             |
| `name`               | text                  |
| `stage`              | status                |
| `value`              | currency              |
| `close_date`         | date                  |
| `associated_company` | → `companies`         |
| `associated_people`  | → `people`[]          |

#### `activities` — typed timeline events (calls, emails, meetings, dms, notes, stage changes)

| Attribute              | Type                                               |
| ---------------------- | -------------------------------------------------- |
| `record_id`            | uuid (pk)                                          |
| `type`                 | enum (`call`, `email`, `meeting`, `dm`, `linkedin_message`, `note`, `stage_change`) |
| `occurred_at`          | timestamp (when the thing happened)                |
| `subject`              | text                                               |
| `body`                 | text (markdown)                                    |
| `direction`            | enum (`inbound`, `outbound`)                       |
| `outcome`              | text (e.g. `completed`, `no_show`, `cancelled`)    |
| `duration_seconds`     | int                                                |
| `source_url`           | text (transcript link, message-id, calendar invite) |
| `associated_person`    | → `people`                                         |
| `associated_company`   | → `companies`                                      |
| `associated_deal`      | → `deals`                                          |
| `metadata`             | json (type-specific extras, e.g. `{from, to}` for `stage_change`) |

## Roadmap
- [x] `.acrm` file format
- [ ] CLI
- [ ] Claude Code skills integration
- [ ] Realtime collaboration (multiplayer mode)
- [ ] Reference web UI (community)