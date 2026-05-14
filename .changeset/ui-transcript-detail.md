---
"@agent-crm/cli": minor
---

Add a transcript detail page (`acrm ui` → `/transcripts/:id`) reachable from the timeline on a person's detail page.

**Layout** — inspired by Granola. Title in serif, pill row with date (`Today` / `Yesterday` / `Mon, May 4`) and participants, then a Summary / Transcript toggle, then the content pane. Both panes are server-rendered; the toggle is a tiny inline script so switching is instant.

**Summary view — markdown rendering.** Summaries from Granola / manual paste arrive as markdown, so the page now renders them as HTML instead of dumping `### Recovery & Current Work` as literal text. Covers headings (`#`..`######`, mapped to `h2`/`h3`/`h4`), unordered and ordered lists with indent-based nesting, inline bold / italic / code, and paragraphs. Lists produce well-formed nested HTML (`<ul><li>…<ul>…</ul></li></ul>`) so deeper bullets visually indent the way you'd expect.

**Transcript view — speaker turns.** Raw transcripts often arrive as one wall of text with speaker tags inlined (`"…hear you.  Them: Very fast.  Me: Got it."`). The page now splits the content into one block per speaker turn. Each turn renders as a small speaker label above the utterance. Detection allows any whitespace between a sentence terminator and the next speaker tag (Granola's two-space convention, single-space, tabs, blank lines), and requires either start-of-text, a newline, or a `.!?` sentence boundary before the tag — so words like "Yeah." inside an utterance don't get mistaken for a turn break. If no speaker tags are detected, the content falls back to a `pre-wrap` block so existing line breaks survive.

**Back button.** A small pill at the top of the transcript page returns the user to the person they came from. The timeline link on the person detail page now passes `?back=/people/:id`; the transcript route reads it (validating it's a same-site path, no `//`-prefixed URLs, to prevent open redirect) and defaults to `/people` if missing. The pill mirrors the visual style of the date/participants pills with a chevron + person glyph.
