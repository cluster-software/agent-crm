---
description: Connect a meeting transcription provider (Granola, Otter, Fireflies, Fathom, Zoom export, manual paste, etc.) so /post-call can pull transcripts into the .acrm workspace. Provider-agnostic — pick which one to use, or connect more than one.
---

agent-crm's `transcripts` object is provider-agnostic. The CLI
(`acrm import transcript`) accepts canonical JSON; this skill connects
one or more providers so `/post-call` can build that JSON automatically.

Provider adapters live in `.claude/transcript-providers/`. Each adapter
describes how to detect, connect, and fetch from one source. To add a new
vendor, drop a new adapter file there following the contract in
`.claude/transcript-providers/README.md` — no changes to this skill required.

## Steps

1. **List providers and their current status.** Read every file in
   `.claude/transcript-providers/` except `README.md`. For each adapter,
   run its **Detect** section to find out whether it's already connected.

   Render a numbered menu, with a status badge:
   ```
   Transcript providers

     1. Granola        [connected]
     2. Manual / file  [always available]
     3. Add new...     (drop a new file in .claude/transcript-providers/)
   ```

   If only one adapter is fully native (e.g. Granola) and others are manual,
   call that out.

2. **Ask the user which provider(s) they want to set up.** Accept a number,
   a name, "all", or "skip". They can pick more than one.

3. **For each selected provider, run its `Connect` section verbatim.**
   - Granola: OAuth dance (URL → wait → complete → verify).
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
  `.claude/transcript-providers/README.md` (the adapter contract) and offer to
  scaffold a new adapter file.
