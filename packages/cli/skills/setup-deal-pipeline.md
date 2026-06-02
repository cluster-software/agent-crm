---
name: setup-deal-pipeline
description: Help an Agent CRM user create or customize a sales deal pipeline in the cloud workspace using first-class `acrm deals` commands. Use for "Create a pipeline for me", "set up my deals pipeline", "customize deal stages", or deals empty states.
---

# setup-deal-pipeline

Use this when the user wants the Deals tab to have a real sales pipeline:
stage options that match how they sell, plus safe handling for any existing
deals.

## Decide if `deals` is the right object

`deals` means sales opportunities. If the user is setting up hiring,
fundraising, customer support, projects, or another workflow, do not coerce it
into `deals`. Suggest a custom object instead.

## Quick setup flow

1. Inspect the current cloud workspace context:

   ```sh
   acrm deals pipeline context --json
   acrm deals pipeline list --json
   ```

2. If communication messages exist, scan the recent message snippets for the
   selling motion:

   - Use a demo stage only when the product appears to require scheduled demos.
   - Use proposal/contract/procurement stages only when they fit the messages.
   - Keep stage names generic and high-level.
   - Always include Closed Won and Closed Lost unless the user explicitly asks
     not to.

3. If the context is thin or ambiguous, ask one short question about how they
   sell, then pick a simple preset.

   Good defaults:

   - Simple sales: `lead`, `qualified`, `proposal`, `closed_won`, `closed_lost`
   - Demo-led: `lead`, `qualified`, `demo_scheduled`, `proposal`, `closed_won`, `closed_lost`
   - Founder-led: `lead`, `discovery`, `follow_up`, `verbal_commit`, `closed_won`, `closed_lost`

4. Apply the pipeline with first-class commands:

   ```sh
   acrm deals pipeline set \
     --stage lead:Lead \
     --stage qualified:Qualified \
     --stage proposal:Proposal \
     --stage closed_won:"Closed Won" \
     --stage closed_lost:"Closed Lost"
   ```

   `acrm deals pipeline set` expects `--stage id:Title` pairs. The backend
   stores each stage as EAV status JSON (`{id,title}`), and the app renders the
   `title`. Do not pass JSON to `--stage`.

5. If the command says existing deals use stages not in the new pipeline, map
   each old id to the closest new generic stage:

   ```sh
   acrm deals pipeline set \
     --stage lead:Lead \
     --stage qualified:Qualified \
     --stage proposal:Proposal \
     --stage closed_won:"Closed Won" \
     --stage closed_lost:"Closed Lost" \
     --map in_progress:qualified \
     --map won:closed_won \
     --map lost:closed_lost
   ```

6. After the pipeline is set, keep the user in flow by asking which real deals
   they want to create next. Suggest concrete paths so the user knows they can
   be specific or criteria-based, for example: "Add Sarah as a deal", "Create a
   deal for Kubby", or "Make deals for all people I've pitched on LinkedIn".
   Ask for the company/person, stage, and next step for each deal; do not invent
   deals without user-provided opportunities or a user-approved criterion.

## Create or update deals

Only create a first deal if the user asks for it or gives a real opportunity.
Before creating deals, search for the real company/person records and link by
id instead of putting names in free-text fields:

```sh
acrm records list companies --search "Acme" --limit 5 --json
acrm records list people --search "Jane Acme" --limit 5 --json
```

Use the returned `record_id` only when the match is confident. If no confident
company or person match exists, say what could not be linked and create the
deal without that reference.

```sh
acrm deals create \
  --name "Acme pilot" \
  --stage qualified \
  --company <company_record_id> \
  --person <person_record_id> \
  --next-step "Schedule discovery call"
```

Use `acrm deals update <deal_id> --stage <stage_id>` to move a deal between
stages, and `acrm deals delete <deal_id>` only when the user explicitly wants
the deal archived.

Do not use `acrm records create deals` or raw EAV writes for cloud deal setup.
Use `acrm deals create` / `acrm deals update` so stage IDs, text values, and
record references are serialized consistently with the backend.

## Hard rules

- Keep the pipeline sales-specific. Use custom objects for non-sales workflows.
- Keep names generic. Avoid hyper-specific stage names inferred from one
  message.
- Do not invent a demo stage when the workspace does not suggest demo-led
  selling.
- Do not archive, clear, or migrate existing deals without an explicit command
  path that preserves or maps their current stage.
