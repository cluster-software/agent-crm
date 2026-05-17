<div align="center">

<img src="https://cdn.shopify.com/s/files/1/0748/5902/0324/files/header_c7055774-5f0b-4794-85f1-15ac9a5d2a25.png?v=1778036454" alt="agent-crm">

</div>

Claude is running your GTM and your leads live in CSVs. Spreadsheets fall apart around 30 deals in: you lose track of who said what, what's open, and what's next. CRMs solve that, but they were built for humans clicking through UIs, not agents reading and writing it on your behalf.

Plug Claude into your CRM via MCP and the schema torches your context, every action is a network round-trip, and you blow through your usage limits. Salesforce and HubSpot are shipping their own CLIs, but they end at the deal record — the scrapes, enrichment runs, and half-cleaned lists that fed it live somewhere else. You can't see what your last scrape pulled in and what it didn't clean up, or pick up where last weekend's list-building session left off.

Agents work best on files. Agent CRM is a portable `.acrm` file your agent can query, edit, diff, and version — pipeline, scrapes, and enrichments, all in one place.

```txt
                    ┌──────────────┐
                    │  Custom UIs  │
                    └──────┬───────┘
                           │
┌────────────┐      ┌──────▼──────┐      ┌───────────────┐
│ AI Agents  ├─────►│  .acrm      │◄─────┤ CLI / Scripts │
└────────────┘      └─────────────┘      └───────────────┘
```

## What's in a `.acrm` file?

A `.acrm` file is a **SQLite database** with a [change-history layer](https://lix.dev) on top. That means:

- **No proprietary format.** Open it with any lix client and your data is right there in standard tables.
- **Every write is a versioned checkpoint.** Like git for your CRM — branch to run an experiment, diff to see what changed, revert if Claude mangles a row.
- **It's just a file.** Copy it, email it, commit it, sync it through Google Drive. No server, no account, no migration tool needed if you ever walk away.

If you can read SQLite, you can read your CRM. That's the whole guarantee.

## Quickstart

Install the CLI:

```bash
npm install -g @agent-crm/cli
```

Create your first `.acrm` file and let Claude rip on it:

```bash
claude --dangerously-skip-permissions
```

Create an .acrm file

```bash
! acrm init pipeline.acrm
```

Then import your CSVs

```bash
! acrm import csv ./leads.csv
```

View your data
```bash
! acrm ui
```

## Why Agent CRM
- **🧩 Headless:** Ships as a CLI.
- **⚒️ Skills based:** Claude writes skills against the CLI (transcript ingestion, stale-deal sweeps, weekly reports) as `.md` files.
- **🧱 Modeled:** uses Attio's data model out of the box — `people`, `companies`, `deals`, `posts`, `transcripts`. Typed, related, queryable with plain SQL. Fixed schema = predictable agent edits.
- **🔀 Version controlled:** every change is a checkpoint on a branch. Diff, merge, revert, time-travel.
- **🔌 Pluggable transcript providers:** `transcripts` are vendor-agnostic. Drop a `transcript-provider-<vendor>` skill into `~/.claude/skills/` to plug in Granola, Otter, Fireflies, Fathom, Zoom, manual paste, or anything else.


## Use cases

A grab-bag of jobs Agent CRM handles today. Each is a skill or a CLI command — bring your own, or use the ones we ship.

**Prep for a sales call.** [`/prep-call`](skills/prep-call.md) pulls the person's full history from your `.acrm`, fetches their LinkedIn profile (cached, 14-day TTL), and hands you a one-pager with discovery questions tied to what they've actually been talking about.

**Pull call transcripts from Granola.** [`/post-call`](skills/post-call.md) fetches the transcript from your connected provider, resolves participants by email, and imports it as a `transcripts` record linked to the attendees. Local, queryable, and easy to spot patterns across calls.

**Draft follow-ups in your voice.** [`/follow-up`](skills/follow-up.md) finds leads with stale activity, reads the prior thread plus any past-call transcripts, and drafts the next message. You review and send.

**Import a scraped list.** `acrm import csv ./leads.csv` ingests a CSV with auto-derived attributes. New columns become typed attributes on the right object — no schema setup.

**Sweep stale deals.** Ask Claude to query your `.acrm` for deals untouched in N days and surface them. It's just SQL underneath, so any filter you can describe, Claude can run.

**Import X / LinkedIn posts.** You're scrolling and see a post worth following up on. Paste the URL into Claude Code — `acrm import post <url>` upserts the post and adds the author as a contact, viewable in the UI.

**Import X / LinkedIn profiles.** Come across someone you want to chat to. Paste the profile URL into Claude Code — `acrm import linkedin <url>` or `acrm import x <handle>` pulls the enriched profile and dedupes against existing people.

**Plug in a new transcript provider.** Adapters are themselves skills. Drop a `transcript-provider-<vendor>` SKILL.md into `~/.claude/skills/` following the contract in [`docs/transcript-provider-protocol.md`](docs/transcript-provider-protocol.md) (Otter, Fireflies, Fathom, Zoom). [`/setup-transcripts`](skills/setup-transcripts.md) picks it up and walks you through connecting it before your first `/post-call`.

**Write your own skill.** Ask Claude for _"a skill that reads my call transcripts, updates deal stages, and posts a summary to Slack"_ and it writes a `.md` file into `~/.claude/skills/`. No code.

**Query with plain SQL.** `acrm execute "SELECT ..."` runs against the Attio-style schema. It's just SQLite — bring any client you like.

