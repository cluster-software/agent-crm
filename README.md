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

- **No proprietary format.** Open it with any SQLite client (`sqlite3 pipeline.acrm`) and your data is right there in standard tables.
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

## Why Agent CRM
- **🧩 Headless:** Ships as a CLI.
- **⚒️ Skills based:** Claude writes skills against the CLI (transcript ingestion, stale-deal sweeps, weekly reports) as `.md` files.
- **🧱 Modeled:** uses Attio's data model out of the box — `people`, `companies`, `deals`, `posts`, `transcripts`. Typed, related, queryable with plain SQL. Fixed schema = predictable agent edits.
- **🔀 Version controlled:** every change is a checkpoint on a branch. Diff, merge, revert, time-travel.
- **🔌 Pluggable transcript providers:** `transcripts` are vendor-agnostic. Drop a new adapter into `.claude/transcript-providers/` to plug in Granola, Otter, Fireflies, Fathom, Zoom, manual paste, or anything else.


## Stateful skills for GTM

Skills are how Claude does the work. Bring your own, or use the ones we ship — `prep-call`, `post-call`, `follow-up`, `setup-transcripts`. Claude can write new ones in seconds.

**[`prep-call`](.claude/skills/prep-call.md).** Before a meeting, Claude pulls the person's full history from your `.acrm`, fetches their LinkedIn profile (cached, 14-day TTL), and hands you a one-pager with discovery questions tied to what they've actually been talking about.

**[`post-call`](.claude/skills/post-call.md).** After a meeting, Claude pulls the transcript from whichever provider you've connected (Granola today; plug in Otter, Fireflies, or any vendor by dropping an adapter into `.claude/transcript-providers/`), resolves the participants in `.acrm` by email, extracts the problem + would-pay signal, and imports it as a `transcripts` record linked to the attendees via `acrm import transcript`. You review the summary before the next sync.

**[`follow-up`](.claude/skills/follow-up.md).** Claude queries `.acrm` for leads with stale activity, reads the prior thread (and any past-call transcripts linked via `people.associated_transcripts`), and drafts the next message in your tone of voice. You review and send.

**[`setup-transcripts`](.claude/skills/setup-transcripts.md).** One-time setup that scans `.claude/transcript-providers/` and walks you through connecting whichever meeting/call sources you use — Granola today (OAuth), manual paste/file always, and any new vendor you've dropped an adapter for. Run it before your first `/post-call`.

Each skill is a markdown file in `.claude/skills/`. Here's what `post-call` looks like:

```markdown
---
description: Pull a meeting transcript from whichever provider you have connected (Granola, manual paste, or any adapter in .claude/transcript-providers/) and import it into .acrm as a `transcripts` record linked to participants.
---

## Steps

1. **Resolve the person** with a SQL lookup:
   `acrm execute "SELECT DISTINCT record_id FROM acrm_value WHERE object_slug = 'people' AND attribute_slug = 'email_addresses' AND active_until IS NULL AND normalized_key = $1" '["<lowercased-email>"]' --json`

2. **Pick a provider.** Read every file in `.claude/transcript-providers/`
   except `README.md`, run each adapter's Detect step, dispatch to the one
   that's connected.

3. **Fetch the transcript** via the chosen adapter (e.g. `mcp__granola__get_meeting_transcript` for Granola; user paste for the manual adapter).

4. **Extract the call fields** (problem, would-pay, next steps) and fold them into a summary block.

5. **Import via the CLI.** Build canonical JSON and pipe to
   `acrm import transcript` — the CLI dedups by `source_id`,
   resolves participants by email, and writes bidirectional links.

6. **Report a short summary.** The user reviews `resolved` /
   `unresolved` participants and the new `transcript_record_id`.
```

Need something custom? Just ask:

> _"Write me a skill that reads my call transcripts, updates deal stages, and posts a summary to Slack."_

