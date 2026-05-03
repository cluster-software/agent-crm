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

> *"log my call with Acme from the Granola transcript and bump the deal to Negotiation"*
>
> *"prep me for tomorrow's call with Globex"*
>
> *"sweep every deal I haven't touched in a week and propose next steps"*

**Talk to Claude. It writes to a file in your repo.** No SaaS to log into, no UI to learn, no per-seat pricing.

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

- 📐 **Opinionated** — a real CRM data model out of the box: `companies`, `people`, `deals`, `activities`. Typed, related, queryable with plain SQL. Fixed schema = predictable agent edits.
- 🧰 **Headless** — no UI. Use the SDK, CLI, or build your own.
- 🤖 **Self-extending** — Claude writes skills against the SDK (transcript ingestion, stale-deal sweeps, weekly reports) as `.ts` files in your repo.
- 🌿 **Version controlled** — every change is a checkpoint on a branch. Diff, merge, revert, time-travel.

**vs. the alternatives:**

- **Attio / Hubspot / Salesforce + MCP** — MCPs burn your context window. Data sits on their servers, edits hit prod with no diff, per-seat pricing on top.
- **Markdown files** — breaks past ~200 files. Cross-file questions (*"deals that slipped this quarter"*) need real relations. You reinvent SQL, badly.
- **Roll your own Postgres** — congrats, you're building a CRM from scratch.

## Who this is for

**Founder-led sales, GTM engineers, and solo consultants** whose primary workspace is already Claude Code — going agent-native from day zero. Either you don't have a CRM, or you'd happily rip out the one you have.

## Claude writes your GTM skills

Because the SDK is open and the file lives next to your code, **Claude Code can author its own automations as skills** — no plugin marketplace, no integration vendor, no waiting on a roadmap.

> _"Write me a skill that runs every Monday, reads my call transcripts, updates deal stages, and posts a summary to Slack."_

Claude writes the skill, drops it in `.claude/skills/`, and runs it on a branch first so you can review.

#### Example: a `weekly-pipeline-review` skill Claude wrote in 30 seconds

```ts
// .claude/skills/weekly-pipeline-review.ts
import { openAcrm } from "@agent-crm/sdk";

export default async function weeklyReview() {
  const crm = await openAcrm("./pipeline.acrm");
  const since = new Date(Date.now() - 7 * 864e5);
  const log = await crm.log({ since });

  return {
    netARR: log.deltaARR,
    wins: log.checkpoints.filter((c) => c.includes("Closed-Won")),
    slips: log.checkpoints.filter((c) => c.includes("close_date")),
    newDeals: log.checkpoints.filter((c) => c.startsWith("add deal")),
  };
}
```


## Version control — what makes agent automation safe

Every change to `pipeline.acrm` is a **checkpoint** on a **version** (branch). Diff, merge, revert — at the cell level.

This is the part that makes agent automation safe.

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

## SDK

```ts
import { openAcrm } from "@agent-crm/sdk";

const crm = await openAcrm("./pipeline.acrm");

const v = await crm.versions.create("weekly-cleanup");
await crm.deals.update("acme-q2", { stage: "Negotiation", amount: 72000 });

const diff = await crm.diff(v, "main");
await crm.merge(v, { into: "main" });
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

Under the hood: SQLite. Query with plain SQL, back up by copying a file. No proprietary format, no vendor lock-in.

> Agent CRM isn't trying to beat Attio at being Attio. If your team needs a polished UI for non-technical reps today, use Attio or HubSpot. If Claude Code is your primary interface and you want agent edits to be *safe*, this is the substrate.


## Roadmap
- [x] `.acrm` file format
- [ ] TypeScript SDK + CLI
- [ ] Claude Code skills integration
- [ ] Python SDK
- [ ] Realtime collaboration (multiplayer mode)
- [ ] Reference web UI (community)