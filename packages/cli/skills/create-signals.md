---
name: create-signals
description: Create or edit Agent CRM local signal definitions. Use when the user wants a new signal, signal bundle, enrichment field, web-researched CRM column, or help testing `acrm signals list|sync|run`.
---

Agent CRM signals are local research tasks that fill normal CRM fields.

## Create a signal

1. Add a Markdown file at `<workspace-dir>/signals/<slug>.md`.
2. Use frontmatter with `slug`, `title`, and `object`.
3. Add one fenced `json acrm-signal` block declaring all outputs.
4. Write the prompt instructions below the block.

Template:

```md
---
slug: hotel_contact_path
title: Hotel Contact Path
object: companies
---

\`\`\`json acrm-signal
{
  "outputs": [
    {
      "key": "operator_status",
      "attribute": "operator_status",
      "title": "Operator status",
      "type": "status",
      "options": [
        "owner_identified:Owner identified",
        "operator_identified:Operator identified",
        "property_contact_only:Property contact only",
        "unclear:Unclear"
      ]
    },
    {
      "key": "outreach_path",
      "attribute": "outreach_path",
      "title": "Outreach path",
      "type": "text"
    }
  ]
}
\`\`\`

Find the best public outreach path. Prioritize first-party pages, imprint/legal
notice pages, contact pages, local press, associations, directories, and award
pages. Cite every factual claim.
```

## Rules

- Use one signal bundle for one research task, even when it fills multiple fields.
- `object` must be `people` or `companies`.
- Supported output types: `text`, `number`, `url`, `date`, `timestamp`, `status`, `select`.
- Do not create booleans. Model yes/no as `status` or `select`.
- Keep `attribute` slugs lowercase snake_case.
- Do not target core fields such as company `name`, `domains`, `linkedin_url`, or person `name`, `email_addresses`, `company`.
- Put user-visible rationale in each field's `reasoning`; never ask for hidden chain-of-thought.
- Prompt for cited public evidence. The runner stores citations, confidence, reasoning, notes, and uncited status in `provenance_json`.

## Test it

From the workspace directory:

```sh
acrm signals list
acrm signals sync
acrm signals run --missing --signal <slug> --object companies --record-id <id> --concurrency 1
```

Imports run missing-only signals in the background unless the user passes
`--no-signals`.

Signal definitions are local files in `signals/`; the definitions themselves
are not stored in Postgres. Synced attributes and generated values are stored
in the Postgres workspace.
