---
name: import-post
description: Import a LinkedIn or X post into the Agent CRM Postgres workspace by URL. Triggers when the user shares a LinkedIn post URL (linkedin.com/posts/..., linkedin.com/feed/update/urn:li:activity:...) or an X/Twitter status URL (x.com/<handle>/status/<id>, twitter.com/...) and wants to track the post or its author. Phrasings — "import this post", "save this LinkedIn post", "track this tweet", "add this person from their post", or just a bare post URL in chat.
---

# import-post

Use when the user pastes a LinkedIn or X **post URL** into chat and wants to capture the post + its author into the Agent CRM workspace.

This is the **post** flow, not the profile flow:

- Post URL → use `acrm import post <url>` (this skill)
- Profile URL (`linkedin.com/in/<slug>` or `x.com/<handle>` with no `/status/...`) → use `acrm import linkedin <url>` or `acrm import x <handle>`

## Recognize a post URL

| Platform  | Post URL shape                                                  |
|-----------|------------------------------------------------------------------|
| LinkedIn  | `https://www.linkedin.com/posts/<slug>_<activity-id>`           |
| LinkedIn  | `https://www.linkedin.com/feed/update/urn:li:activity:<id>/`    |
| X         | `https://x.com/<handle>/status/<id>` (query params like `?s=12` are fine) |
| X         | `https://twitter.com/<handle>/status/<id>`                      |

If the URL has `/status/` (X) or `activity:` / `/posts/` (LinkedIn), it's a post. Anything else is a profile or different surface — pick a different command.

## Run

```sh
acrm import post '<url>'
```

That's it. The CLI handles everything:

1. **Sniffs the platform** from the URL host.
2. **Fetches the post via Apify** (`apimaestro/linkedin-post-detail` for LinkedIn, `apidojo/twitter-scraper-lite` for X). Cached 14 days under `.cache/{linkedin,x}-posts/`.
3. **Extracts the author profile URL** from the post response and chains into the existing profile import flow, so the author is deduped against any existing person by `linkedin_url` or `twitter_url`.
4. **Upserts the `posts` record** (deduped by normalized URL) with `url`, `platform`, `author` (→ people), `posted_at`, `content`.
5. **Links the person → post** via `people.associated_posts` (skips if already linked).

Re-running the same URL is idempotent — `created` will be `false` for everything.

## Prereqs

- Workspace must be initialized (`acrm init` with `ACRM_DATABASE_URL`, `NEON_DATABASE_URL`, `SUPABASE_DATABASE_URL`, `DATABASE_URL`, or `-w <postgres-url>`).
- `APIFY_API_TOKEN` must be set in `.env` in the current project directory or in the shell environment. Without it the command fails with a clear hint.

## Output

JSON shape (use `--json` or it's auto-emitted when stdout isn't a TTY):

```json
{
  "ok": true,
  "data": {
    "post_record_id": "...",
    "person_record_id": "...",
    "company_record_id": "..." | null,
    "created": { "post": true|false, "person": true|false, "company": true|false },
    "platform": "linkedin" | "x",
    "post_url": "<normalized>",
    "cache_paths": { "post": "...", "profile": "..." },
    "cache_hits": { "post": true|false, "profile": true|false },
    "mapped": { "post_url": "...", "author_profile_url": "...", "posted_at": "YYYY-MM-DD"|null, "content": "..." }
  }
}
```

## Report

After running, give a short one-liner:

```
Imported post by <Name> (<platform>) — person <created|matched existing>, post <created|matched existing>. Posted <YYYY-MM-DD>: "<first 80 chars of content>…"
```

If `needs_enrichment` is set on the chained X profile import (the X bio contained role/company hints but those fields are empty on the person), trigger the `enrich-x-bio` skill on the returned payload.

## Hard rules

- **Never** fabricate a URL. If the user pastes something that isn't a recognizable post URL, ask before running.
- **Never** pass URLs from untrusted sources without showing the user what's about to be imported.
- **Don't** delete or overwrite the existing post record on re-import. The CLI already handles dedup — just rerun.
