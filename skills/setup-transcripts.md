---
description: Connect a meeting transcription provider (Granola, Otter, Fireflies, Fathom, Zoom export, manual paste, etc.) so /post-call can pull transcripts into the .acrm workspace. Provider-agnostic — pick which one to use, or connect more than one.
---

agent-crm's `transcripts` object is provider-agnostic. The CLI
(`acrm import transcript`) accepts canonical JSON; this skill connects
one or more providers so `/post-call` can build that JSON automatically.

Provider adapters are themselves skills, named `transcript-provider-<vendor>`
(e.g. `transcript-provider-granola`, `transcript-provider-manual`). Each one
describes how to detect, connect, and fetch from one source. To add a new
vendor, drop a new `transcript-provider-<name>` SKILL.md into
`~/.claude/skills/` following the contract in
`docs/transcript-provider-protocol.md` of the agent-crm repo — no changes to
this skill required.

## Steps

1. **List providers and their current status.** Enumerate the available
   adapter skills — every installed skill whose name starts with
   `transcript-provider-`. For each one, invoke it and run its **Detect**
   section to find out which of the three states it's in: `connected`,
   `unauthenticated`, or `not_installed`.

   Render a numbered menu, with the state in the badge so each provider's
   next action is obvious:
   ```
   Transcript providers

     1. Granola        [not installed — run `claude mcp add` first]
     2. Granola        [installed, needs OAuth]
     3. Granola        [connected]
     4. Manual / file  [always available]
     5. Add new...     (drop a new transcript-provider-<name> SKILL.md into ~/.claude/skills/)
   ```

   (Only one row per provider in practice — the example shows all three
   states for clarity.) If only one adapter is fully native (e.g. Granola)
   and others are manual, call that out.

2. **Ask the user which provider(s) they want to set up.** Accept a number,
   a name, "all", or "skip". They can pick more than one.

3. **For each selected provider, run its `Install` section (if state is
   `not_installed`), then its `Connect` section (if state is
   `unauthenticated`), then re-run `Detect` to verify.**
   - Granola, `not_installed`: print the `claude mcp add` command, ask the
     user to run it and restart Claude Code, then stop — re-running
     `/setup-transcripts` after the restart picks up from `unauthenticated`.
   - Granola, `unauthenticated`: OAuth dance (URL → wait → complete → verify).
   - Manual / file: no-op — just tell the user what to expect when they run
     `/post-call` (they'll paste or file-import).
   - Future native providers: whatever their adapter says.

4. **Verify.** For each provider just connected, re-run its **Detect** section.
   Report:
   ```
   Connected:
     ✓ Granola
   Available (no setup needed):
     • Manual / file
   ```

5. **Tell the user what to do next.**
   - "Try `/post-call <name>` after your next meeting. It will pick the right
     provider based on what's connected."
   - "Re-run `/setup-transcripts` any time to add or re-auth a provider."

## Notes

- This skill is safe to re-run. If a provider is already connected, the adapter's
  Detect should short-circuit its Connect step.
- This skill does **not** touch the `.acrm` workspace. Connection state lives in
  the providers themselves (MCP token storage, `.env`, etc.).
- If the user wants a provider that isn't yet supported, point them at
  `docs/transcript-provider-protocol.md` in the agent-crm repo (the adapter
  contract) and offer to scaffold a new `transcript-provider-<vendor>` skill.
