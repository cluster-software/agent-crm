<div align="center">

```txt
   █████╗  ██████╗ ███████╗███╗   ██╗████████╗     ██████╗██████╗ ███╗   ███╗
  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝    ██╔════╝██╔══██╗████╗ ████║
  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║       ██║     ██████╔╝██╔████╔██║
  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║       ██║     ██╔══██╗██║╚██╔╝██║
  ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║       ╚██████╗██║  ██║██║ ╚═╝ ██║
  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝        ╚═════╝╚═╝  ╚═╝╚═╝     ╚═╝
```

**The headless crm for claude code.**

</div>

---

Agent CRM is a headless CRM built for AI-native sales and go-to-market workflows.
(
  - what exactly is this, no clear mental picture
  - the headless CRM that enables claude code to do X (be more concrete)
  - crm in a box for claude
    - annoying to setup attio, wire up MCPs
    - with agent crm you can get started right away
)

Every CRM provider now ships with an MCP and a chat bolted on the a dashboard. Underneath, they're still dashboards from 2012 with humans as the core user type in mind with an AI veneer.

Agent CRM is built from the ground-up for agents as the primary user. The source of truth is a `.agent-crm` workspace. UIs, CLIs, and scripts are clients.

```txt
                    ┌──────────────┐
                    │  Custom UIs  │
                    └──────┬───────┘
                           │
┌────────────┐      ┌──────▼──────┐      ┌───────────────┐
│ AI Agents  ├─────►│  .agent-crm │◄─────┤ CLI / Scripts │
└────────────┘      └─────────────┘      └───────────────┘
```

## Why Agent CRM
(
  - how is this different than just MDs, help claude scalably keep track of conversations without having to pay for Hubspot, Attio, etc
  - better than markdown becuase you have a datamodel
  - better than notion because its more opinionated, it doesn't bloat your context window
)

- **Headless** — no built-in UI. Interact via SDK, CLI, or any UI you build on top.
- **Claude rips on your CRM** — Claude Code writes its own skills against the SDK. Weekly reports, transcript ingestion, enrichment, stale-deal sweeps — all authored by the agent, all living as `.ts` files in your repo.
- **Version controlled** — every change is a checkpoint on a branch. Diff, merge, revert, time-travel. Agents propose changes safely; you review and merge.

## Who this is for

Technical founders and GTM engineers running their go-to-market motion through Claude Code, **without an existing CRM**. Agent CRM is built for teams going agent-native from day zero — not a migration target for existing HubSpot, Attio or Salesforce pipelines.


## Claude automates your CRM

Because the SDK is open and the file lives next to your code, **Claude Code can author its own automations as skills** — no plugin marketplace, no integration vendor, no waiting on a roadmap.

> _"Write me a skill that runs every Monday, reads my call transcripts, updates deal stages, and posts a summary to Slack."_

Claude writes the skill, drops it in `.claude/skills/`, and runs it on a branch first so you can review.

#### More skills Claude can write for you

- `prep` — research prospect and prep for a call
- `post-call` — extract transcript and add an entry in the crm

Every skill is just an `.md` file in your repo. **You can read it, edit it, version it, delete it.**

## Version controlled

Every change to `.agent-crm` is a **checkpoint** on a **version** (branch). Diff, merge, revert.

This is the part that makes agent automation safe.

## Quickstart

Install the CLI:

```bash
npm install -g @agent-crm/cli
```

Create your first workspace:

```bash
agent-crm init                         # creates .agent-crm workspace
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

Stage transitions on `people.lifecycle_stage` and `deals.stage` automatically emit `stage_change` activities so the funnel history falls out of the timeline. Pipeline timestamps like "last touch" or "first reply" are derived from activities — they aren't denormalized columns.

Conversation activities (calls, meetings) can carry one or more **transcripts** as a subordinate primitive — same row carries `content`, optional structured `segments` (`[{speaker_label, person_id?, start_seconds?, end_seconds?, text}]`), `source` (`granola`/`otter`/`whisper`/`manual`), and `format`. Stored in a separate `transcripts` table so the activity timeline stays lean; cascade-deletes with the parent activity. The transcript URL itself lives on `activities.source_url`; `transcripts.content` holds the verbatim text once fetched.

Every object also carries `created_at`, `created_by`, and `updated_at` automatically.

Schema is open and extensible — add custom attributes on any object, or define your own objects. Under the hood, `.agent-crm` is a SQLite database. Queryable with plain SQL, backed up by copying a file. No proprietary format, no vendor lock-in.

Agent CRM isn't trying to beat Attio at being Attio. If your team needs a polished UI for non-technical reps today, use Attio or HubSpot. If Claude Code is your primary interface and you want agent edits to be *safe*, this is the substrate.

## What this isn't

- **Not a migration target.** There's no HubSpot/Salesforce importer. This is for teams starting their CRM from zero.


## Roadmap
- [ ] TypeScript SDK + CLI
- [ ] Realtime collaboration (multiplayer mode)
- [ ] Cloud hosting
