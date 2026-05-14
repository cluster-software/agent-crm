---
"@agent-crm/cli": minor
---

Show imported posts on the person detail page (`acrm ui` → `/people/:id`) alongside transcripts.

**Toggle.** The person page now has a Transcripts / Posts segmented toggle below the contact section, each tab showing its item count. Transcripts remain the default view so existing behavior is preserved.

**Native embeds, not snippets.** Posts render as actual previews, not text rows. X posts use the official `platform.twitter.com/widgets.js` blockquote with `data-theme="dark"` so they sit naturally on the dark UI; LinkedIn posts use the official `linkedin.com/embed/feed/update/<urn>` iframe wrapped in a light card. Clicks inside an embed open the original post on x.com / linkedin.com in a new tab via the embed's own behavior — there is no separate post detail route.

**Tab-switch widget refresh.** The X widget skips blockquotes that were processed while their container was `display:none`, so switching to the Posts pane re-invokes `twttr.widgets.load(...)` on the now-visible pane to render any tweets that didn't materialize on the first pass.

**Date label fix.** `dateGroupLabel` now parses bare `YYYY-MM-DD` strings as local dates. Previously `new Date("2026-05-14")` produced UTC midnight, so in CST (UTC−6) a post dated today read as "Yesterday". Transcripts were unaffected because `started_at` includes a timezone.
