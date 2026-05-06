<div align="center">

<img src="assets/header.png" alt="agent-crm">

</div>

Claude is now running your GTM. Your lead lists live in CSVs because you want to move fast with claude code, but existing CRMs were built for humans, not agents. Their MCPs slow you down, bloat your context, and kill your usage limits.

Agent CRM gives your agent a structured backend it can query, edit, diff and validate, fast.

The source of truth is a portable `.acrm` file. UIs, CLIs, scripts, and agents all operate on it and you can send it around like any other file.

```txt
                    ┌──────────────┐
                    │  Custom UIs  │
                    └──────┬───────┘
                           │
┌────────────┐      ┌──────▼──────┐      ┌───────────────┐
│ AI Agents  ├─────►│  .acrm      │◄─────┤ CLI / Scripts │
└────────────┘      └─────────────┘      └───────────────┘
```

## Quickstart

Install the CLI:

```bash
npm install -g @agent-crm/cli
```

Create your first `.acrm` file and let Claude rip on it:

```bash
claude --dangerously-skip-permissions
```

```bash
acrm init cluster.acrm                 # creates cluster.acrm file
```

Then to import your existing leads:

```bash
acrm import csv ./leads.csv
```

And query the file any time with:

```bash
acrm execute "select * from people limit 5;"
```

## Why Agent CRM
- **🧩 Headless:** Ships as a CLI.
- **⚒️ Skills based:** Claude writes skills against the CLI (transcript ingestion, stale-deal sweeps, weekly reports) as `.md` files.
- **🧱 Modeled:** uses Attio's data model out of the box. Typed, related, queryable with plain SQL. Fixed schema = predictable agent edits.
- **🔀 Version controlled:** every change is a checkpoint on a branch. Diff, merge, revert, time-travel.


## How Claude runs your GTM

Skills are how Claude does the work. Bring your own, or use the ones we ship — `prep-call`, `post-call`, `follow-up`, `stale-opportunities`, `champion-left`, `new-hire-trigger`. Claude can write new ones in seconds.

**[`prep-call`](.claude/skills/prep-call.md).** Before a meeting, Claude pulls the person's full history from your `.acrm`, fetches their LinkedIn profile (cached, 14-day TTL), and hands you a one-pager with discovery questions tied to what they've actually been talking about.

**[`post-call`](.claude/skills/post-call.md).** After a meeting, Claude pulls the transcript from Granola, resolves the person in `.acrm`, extracts the problem + would-pay signal, and writes a `last_call` value plus any deal-stage update via `acrm execute`. You review the SQL output before the next sync.

**[`follow-up`](.claude/skills/follow-up.md).** Claude queries `.acrm` for leads with stale activity, reads the prior thread for each, and drafts the next message in your tone of voice. You review and send.

**[`stale-opportunities`](.claude/skills/stale-opportunities.md).** Run nightly. Claude finds deals stuck in qualified/proposal for 60+ days, re-enriches the primary contact via Apollo, scans for new ICP-matched hires and news signals at the account, and writes back a status (`actionable` / `dead` / `needs_review`) with a one-line narrative so AEs can triage in seconds.

**[`champion-left`](.claude/skills/champion-left.md).** Run biweekly. Claude scans open pipeline for primary contacts whose Apollo employment record changed in the last 14 days and DMs the assigned AE the affected deals, departure dates, and the champion's new employer — so you can pivot to a new contact before the deal goes cold.

**[`new-hire-trigger`](.claude/skills/new-hire-trigger.md).** Run monthly. Claude searches Apollo for ICP-matched executives (VP Sales, CRO, Head of RevOps, etc.) hired in the last 30 days at your ABM accounts, flags the ones with open pipeline, and surfaces a re-engagement list — a new buyer often resets a stalled deal.

Each skill is a markdown file in `.claude/skills/`. Here's what `post-call` looks like:

```markdown
---
description: Pull a Granola transcript, resolve the person in .acrm, and log the call via SQL — using the CLI's three commands: init, import csv, execute.
---

## Steps

1. **Resolve the person** with a SQL lookup against `.acrm`:
   `acrm execute "SELECT DISTINCT record_id FROM acrm_value WHERE object_slug = 'people' AND attribute_slug = 'email_addresses' AND active_until IS NULL AND normalized_key = ?" '["<email>"]' --json`

2. **Find the Granola meeting** via `mcp__granola__list_meetings`. Filter
   to meetings where the person's name appears in the title or
   participants. If multiple, ask the user to pick.

3. **Fetch the transcript** with `mcp__granola__get_meeting_transcript`.

4. **Extract the call fields** (problem, would-pay, next steps).

5. **Write back via `acrm execute`.** Close the previous `last_call`
   value (`UPDATE acrm_value SET active_until = …`) and insert a new
   one. Update the deal's `stage` the same way if it moved.

6. **Report a short summary.** The user reviews the JSON output.
```

Need something custom? Just ask:

> _"Write me a skill that reads my call transcripts, updates deal stages, and posts a summary to Slack."_

