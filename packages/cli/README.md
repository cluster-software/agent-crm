<div align="center">

<img src="https://cdn.shopify.com/s/files/1/0748/5902/0324/files/header_c7055774-5f0b-4794-85f1-15ac9a5d2a25.png?v=1778036454" alt="agent-crm">

</div>

Claude is running your GTM and your leads live in CSVs. Spreadsheets fall apart around 30 deals in: you lose track of who said what, what's open, and what's next. CRMs solve that, but they were built for humans clicking through UIs, not agents reading and writing it on your behalf.

Plug Claude into your CRM via MCP and the schema torches your context, every action is a network round-trip, and you blow through your usage limits. Salesforce and HubSpot are shipping their own CLIs, but they end at the deal record — the scrapes, enrichment runs, and half-cleaned lists that fed it live somewhere else. You can't see what your last scrape pulled in and what it didn't clean up, or pick up where last weekend's list-building session left off.

Agent CRM is a cloud-first CRM your agent can edit through first-class CLI and API operations — pipeline, scrapes, enrichments, and multiplayer collaboration in one place.

```txt
                    ┌──────────────┐
                    │  Custom UIs  │
                    └──────┬───────┘
                           │
┌────────────┐      ┌──────▼──────┐      ┌───────────────┐
│ AI Agents  ├─────►│ REST / CLI  │◄─────┤ App / Scripts │
└────────────┘      └─────────────┘      └───────────────┘
```

## Where is the CRM stored?

Agent CRM is cloud-first and stores workspace data in **Neon, Supabase, or any Postgres-compatible database**. The schema remains flexible EAV: `acrm_object`, `acrm_attribute`, `acrm_record`, and `acrm_value`. Set `ACRM_DATABASE_URL`, `NEON_DATABASE_URL`, or `SUPABASE_DATABASE_URL` to target a workspace.

## Quickstart

Install the CLI:

```bash
npm install -g @agent-crm/cli
```

Create your first CRM workspace and let Claude rip on it:

```bash
claude --dangerously-skip-permissions
```

Initialize the database schema

```bash
! acrm init
```

Then import your CSVs

```bash
! acrm import csv ./leads.csv
```

## Why Agent CRM
- **🧩 Headless:** Ships as a CLI.
- **⚒️ Skills based:** Claude writes skills against the CLI (transcript ingestion, stale-deal sweeps, weekly reports) as `.md` files.
- **🧱 Modeled:** uses Attio's data model out of the box — `people`, `companies`, `deals`, `posts`, `transcripts`. Typed, related records with predictable agent edits.
- **👥 Multiplayer:** workspace state lives in Postgres, so teammates and agents share the same source of truth.
- **🔌 Pluggable transcript providers:** `transcripts` are vendor-agnostic. Drop a `transcript-provider-<vendor>` skill into `~/.claude/skills/` to plug in Granola, Otter, Fireflies, Fathom, Zoom, manual paste, or anything else.


## Use cases

A grab-bag of jobs Agent CRM handles today. Each is a skill or a CLI command — bring your own, or use the ones we ship.

**Pull call transcripts from Granola.** `acrm connect granola` stores a user-provided Granola API key in the hosted sync engine, and `acrm import granola` brings synced transcripts into the Postgres workspace with attendees linked as people. Queryable and easy to spot patterns across calls.

**Import a scraped list.** `acrm import csv ./leads.csv` ingests a CSV with auto-derived attributes. New columns become typed attributes on the right object — no schema setup.

**Import your LinkedIn network.** `acrm connect linkedin` opens the hosted LinkedIn connect flow. After that, `acrm import linkedin` imports existing 1st-degree connections as lightweight contacts, with `--cutoff-date <YYYY-MM-DD>` for recent connections.

**Keep CRM data current.** Use first-class CLI commands and Agent CRM skills to import, update, dedupe, and enrich records without exposing raw SQL.

**Import X / LinkedIn posts.** You're scrolling and see a post worth following up on. Paste the URL into Claude Code — `acrm import post <url>` upserts the post and adds the author as a contact.

**Import X / LinkedIn profiles.** Come across someone you want to chat to. Paste the profile URL into Claude Code — `acrm import linkedin <url>` or `acrm import x <handle>` pulls one enriched profile and dedupes against existing people.

**Plug in a new transcript provider.** Adapters are themselves skills. Drop a `transcript-provider-<vendor>` SKILL.md into `~/.claude/skills/` following the contract in [`docs/transcript-provider-protocol.md`](docs/transcript-provider-protocol.md) (Otter, Fireflies, Fathom, Zoom). Native providers can also add first-class CLI imports like `acrm import granola`.

**Write your own skill.** Ask Claude for _"a skill that reads my call transcripts, updates deal stages, and posts a summary to Slack"_ and it writes a `.md` file into `~/.claude/skills/`. No code.
