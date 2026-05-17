import type { TranscriptPayload } from "./transcript.js";

// Options the caller passes to every provider operation. `configDir` is the
// resolved path to the acrm config dir (where cached OAuth tokens live);
// the SDK never reads it from process.env directly. The CLI's
// `acrmConfigDir()` helper resolves ACRM_CONFIG_DIR and threads it through.
export type ProviderFetchOpts = {
  configDir?: string;
};

// Transcript provider contract.
//
// To add a new provider:
//   1. Create `src/integrations/<name>.ts` exporting a TranscriptProvider value.
//   2. Add it to the array in `src/integrations/providers.ts`.
//
// `acrm auth <name>` and `acrm import transcript --from <name>` pick it up
// from there — no edits to either command file required.
export type TranscriptProvider = {
  // Lowercase identifier used on the CLI: `acrm auth <name>`,
  // `acrm import transcript --from <name>`. Also used as the cached-token
  // filename (~/.config/acrm/<name>.json) and as `transcripts.source`.
  name: string;

  // Human-readable label used in CLI help text and error messages.
  label: string;

  // Fetch a meeting transcript and return the canonical payload. Should
  // throw AcrmError(IMPORT, hint="run: acrm auth <name>") when the cached
  // token is missing.
  fetchTranscript(
    meetingId: string,
    opts?: ProviderFetchOpts,
  ): Promise<TranscriptPayload>;

  // Optional OAuth 2.0 + PKCE config. Providers without OAuth (API key,
  // webhook export, manual paste) leave this unset; the `acrm auth <name>`
  // subcommand is only registered when this is present.
  //
  // `clientId` is optional: if absent and the discovery doc advertises a
  // `registration_endpoint`, the auth flow performs RFC 7591 Dynamic Client
  // Registration to obtain one. Set it explicitly to use a pre-registered
  // public client.
  oauth?: {
    discoveryUrl: string;
    clientId?: string;
    scope?: string;
  };
};
