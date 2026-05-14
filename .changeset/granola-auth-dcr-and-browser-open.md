---
"@agent-crm/cli": patch
---

Fix `acrm auth granola` — Dynamic Client Registration + auto-open browser.

Two bugs were stacking on top of each other.

**Bug 1: hardcoded `client_id` was never registered with Granola.** The provider config hardcoded `client_id=acrm-cli`, but Granola's MCP OAuth server requires RFC 7591 Dynamic Client Registration (advertised via `registration_endpoint` in the discovery doc). The authorize URL returned `application_not_found` and the flow died before the user could even consent.

The auth flow now POSTs to the discovery doc's `registration_endpoint` (with the actual loopback `redirect_uri` for this run) whenever the provider didn't supply a static `clientId`, gets back a fresh `client_id`, and uses it for the authorize + token-exchange steps. The registered `client_id` (and `client_secret`, if any) is persisted alongside the token in `~/.config/acrm/<provider>.json` so future refresh-token exchanges reuse the same client identity.

The provider config now treats `clientId` as optional. `ACRM_GRANOLA_CLIENT_ID` still overrides DCR if you have a pre-registered public client. For every other provider, leaving `clientId` unset opts into DCR automatically — adapters with no `registration_endpoint` get a clear error pointing at the env var or `--token` escape hatch.

**Bug 2: `! acrm auth granola` from inside Claude Code never showed the URL.** Claude Code's bash tool buffers stdout/stderr until the command exits. The auth command blocks indefinitely on the OAuth callback, so the URL never reached the screen and the user was stuck. Fixed by auto-opening the system browser (`open` / `xdg-open` / `start`) right after building the authorize URL. The URL is still printed (to stderr) as a fallback for headless environments.

**Touched files.** `src/commands/auth.ts` (DCR call site, `registerClient()` helper, browser auto-open), `src/integrations/provider.ts` (`clientId` made optional, comment updated), `src/integrations/granola.ts` (drop the bogus `acrm-cli` default), `src/lib/token-cache.ts` (`CachedToken` carries `client_id` / `client_secret` / `registration_endpoint`).
