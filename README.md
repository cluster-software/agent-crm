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
- **🧱 Modeled:** uses [Attio's data model](./SCHEMA.md) out of the box. Typed, related, queryable with plain SQL. Fixed schema = predictable agent edits.
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

## Roadmap
- [x] `.acrm` file format
- [ ] CLI
- [ ] Claude Code skills integration
- [ ] Realtime collaboration (multiplayer mode)
- [ ] Reference web UI (community)