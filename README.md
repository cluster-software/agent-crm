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

Agent CRM is a headless CRM built for AI-native GTM workflows.

Instead of clicking through a dashboard, you talk to Claude: *"log my call with Acme from the Granola transcript and bump the deal to Negotiation"*, *"prep me for tomorrow's call with Globex"*, *"sweep every deal I haven't touched in the last week and propose next steps"*. Claude does the work against a local file that lives in your repo - no SaaS to log into, no UI to learn, no per-seat pricing.

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

You get a real CRM data model out of the box — `companies`, `people`, `deals`, and `activities` (calls, emails, meetings, transcripts, stage changes). Typed, related, queryable with plain SQL. Your agent doesn't have to invent what a deal is or how a call transcript links back to a contact — the schema is there from `agent-crm init`.

The alternatives all fall short:

- **Attio + MCP / Salesforce + MCP** — MCPs eat your context window. Every tool definition loads up front, every query round-trips verbose JSON, and you burn tokens on every read and write. The data still lives on their servers, the schema is still theirs, edits hit production with no diff to review, and you're paying per seat on top.
- **Markdown files in a folder** — works great until you hit ~200 md files: `grep` and `bash` stop returning answers in human time, and cross-file questions like *"which deals slipped this quarter and who owns them?"* need real relations. You end up reinventing SQL — badly.
- **Roll your own Postgres** — congratulations, you're building a CRM from scratch.

Agent CRM is the substrate underneath: a `.agent-crm` workspace — a single SQLite file in your repo with the schema, the relationships, and version-controlled edits already in the box. Four properties make it work:

- **Opinionated** — four objects, fixed (`companies`, `people`, `deals`, `activities`). Flexible-schema tools (Notion, Airtable, custom Attio objects) hand your agent too many degrees of freedom and the data model drifts between runs. Constraint is what makes agent edits predictable.
- **Headless** — no built-in UI. Interact via SDK, CLI, or any UI you build on top.
- **Claude writes its own skills** — Claude rips on your CRM. Tell it what you want and it writes the skill against the SDK: weekly reports, transcript ingestion, enrichment, stale-deal sweeps — all living as `.ts` files in your repo. No plugin marketplace, no integration vendor, no waiting on a roadmap.
- **Version controlled** — every change is a checkpoint on a branch. Diff, merge, revert, time-travel. Agents propose changes safely; you review and merge.

## Who this is for

**Founder-led sales, GTM engineers, and solo consultants** whose primary workspace is already Claude Code — going agent-native from day zero. Either you don't have a CRM, or you'd happily rip out the one you have.

**Not for you (yet):** teams of 5+ AEs that need realtime collaboration, anyone with years of HubSpot, Attio, or Salesforce data to migrate, or shops where reps won't open a terminal.

## Version controlled

Every change to `.agent-crm` is a **checkpoint** on a **version** (branch). Diff, merge, revert. This is the part that makes agent automation safe.

The flow: an agent works on a version (`monday-cleanup`), bulk-updates deal stages, enriches contacts. It misclassifies 5 deals. You diff against `main`, reject the 5 bad cells, merge the rest.

```bash
agent-crm diff monday-cleanup
agent-crm merge monday-cleanup \
  --reject deals:globex-q2:stage \
  --reject deals:initech:value
```

Every checkpoint is a snapshot you can rewind to with `agent-crm checkout <checkpoint>` — full history with `agent-crm log`.

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

Every object carries `created_at`, `created_by`, and `updated_at` automatically. Add custom attributes or define your own objects. Under the hood, `.agent-crm` is a SQLite database — query with plain SQL, back up by copying a file. No proprietary format, no vendor lock-in.

Agent CRM isn't trying to beat Attio at being Attio. If your team needs a polished UI for non-technical reps today, use Attio or HubSpot. If Claude Code is your primary interface and you want agent edits to be *safe*, this is the substrate.


## Roadmap
- [ ] TypeScript SDK
- [ ] CLI
- [ ] Realtime collaboration (multiplayer mode)
- [ ] Cloud hosting
