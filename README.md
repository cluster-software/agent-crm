<div align="center">

<img src="https://cdn.shopify.com/s/files/1/0748/5902/0324/files/header_c7055774-5f0b-4794-85f1-15ac9a5d2a25.png?v=1778036454" alt="agent-crm">

</div>

<br />

<div align="center" style="margin:24px 0;">
  <a href="https://github.com/cluster-software/agent-crm-app/releases/latest" style="display:inline-block; margin-right:8px; text-decoration:none; outline:none; border:none;">
    <img src="https://cdn.shopify.com/s/files/1/0748/5902/0324/files/download_0dff1946-6eea-4433-a53f-f6f562442834.png?v=1779414386" alt="Download for macOS" height="45">
  </a>
</div>

<br />

Let Claude run sales for you. Claude needs a source of truth but existing CRMs are too hard for Claude to work with. Their MCPs torch your context window, every action is a network round-trip, and you blow through your usage limits.

Solution: Agent CRM. Headless, scriptable, with a CLI for Claude to interact with.

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

## Why Agent CRM
- **🧩 Headless:** Ships as a CLI.
- **⚒️ Skills based:** Claude writes skills against the CLI (transcript ingestion, stale-deal sweeps, weekly reports) as `.md` files.
- **🧱 Modeled:** uses Attio's data model out of the box — `people`, `companies`, `deals`, `posts`, `transcripts`, and communication records. Typed, related, queryable with plain SQL. Fixed schema = predictable agent edits.
- **🔀 Version controlled:** every change is a checkpoint on a branch. Diff, merge, revert, time-travel.
- **🔌 Pluggable transcript providers:** `transcripts` are vendor-agnostic. Drop a `transcript-provider-<vendor>` skill into `~/.claude/skills/` to plug in Granola, Otter, Fireflies, Fathom, Zoom, manual paste, or anything else.


## Use cases

A grab-bag of jobs Agent CRM handles today. Each is a skill or a CLI command — bring your own, or use the ones we ship.

**Pull call transcripts from Granola.** `acrm connect granola` stores a user-provided Granola API key in the hosted sync engine, and `acrm import granola` brings synced transcripts into your local workspace with attendees linked as people. Local, queryable, and easy to spot patterns across calls.

**Draft follow-ups in your voice.** [`/follow-up`](packages/cli/skills/follow-up.md) finds leads with stale activity, reads the prior thread plus any past-call transcripts, and drafts the next message. You review and send.

**Import a scraped list.** `acrm import csv ./leads.csv` ingests a CSV with auto-derived attributes. New columns become typed attributes on the right object — no schema setup.

**Sync Gmail.** `/acrm-onboarding` starts hosted Google OAuth. The sync engine imports Gmail in the background, and the Electron app pulls people, threads, and messages back into your local `.acrm` file.

**Import your LinkedIn network.** `acrm connect linkedin` opens the hosted LinkedIn connect flow. After that, `acrm import linkedin` imports existing 1st-degree connections as lightweight contacts, with `--cutoff-date <YYYY-MM-DD>` for recent connections.

**Sweep stale deals.** Ask Claude to query your `.acrm` for deals untouched in N days and surface them. It's just SQL underneath, so any filter you can describe, Claude can run.

**Import X / LinkedIn posts.** You're scrolling and see a post worth following up on. Paste the URL into Claude Code — `acrm import post <url>` upserts the post and adds the author as a contact.

**Import X / LinkedIn profiles.** Come across someone you want to chat to. Paste the profile URL into Claude Code — `acrm import linkedin <url>` or `acrm import x <handle>` pulls one enriched profile and dedupes against existing people.

**Plug in a new transcript provider.** Adapters are themselves skills. Drop a `transcript-provider-<vendor>` SKILL.md into `~/.claude/skills/` following the contract in [`docs/transcript-provider-protocol.md`](docs/transcript-provider-protocol.md) (Otter, Fireflies, Fathom, Zoom). Native providers can also add first-class CLI imports like `acrm import granola`.

**Write your own skill.** Ask Claude for _"a skill that reads my call transcripts, updates deal stages, and posts a summary to Slack"_ and it writes a `.md` file into `~/.claude/skills/`. No code.

**Query with plain SQL.** `acrm execute "SELECT ..."` runs against the Attio-style schema. It's just SQLite — bring any client you like.
