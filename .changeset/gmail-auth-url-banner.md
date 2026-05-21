---
"@agent-crm/cli": patch
---

Fix `acrm import gmail` OAuth URL truncation. When `gws` prints the consent
URL because it can't auto-open a browser (Claude Code's Bash tool, CI, ssh
without `$BROWSER`), acrm now detects the URL in the stream, prints a
clearly-delimited `===== ACRM AUTH URL =====` banner, and writes the URL to
`<tmpdir>/acrm-auth-url.txt` so skills can read it back without scraping the
truncated stderr. The `acrm-onboarding` skill is updated to surface the full
URL to the user as a clickable link.
