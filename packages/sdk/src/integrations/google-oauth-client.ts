// Bundled OAuth credentials for `acrm import gmail`.
//
// Why credentials live in source: per Google's "OAuth 2.0 for Desktop apps"
// docs, "the client secret cannot actually be kept secret in installed
// applications. Therefore it is considered public information." This is the
// same pattern used by `gh`, `supabase`, `vercel`, `gcloud`, and every other
// public CLI that talks to Google. Shipping the client_id + client_secret in
// the npm package is intended.
//
// What this buys us: end users do not need a GCP project, do not need
// gcloud, do not need to click through the Cloud Console to create an OAuth
// client. They run `acrm import gmail`, consent in their browser once, and
// the import runs. acrm's CLI writes this credential file into the gws
// config dir on first run.
//
// Replacing during development: set ACRM_GOOGLE_CLIENT_ID +
// ACRM_GOOGLE_CLIENT_SECRET in the environment to override the bundled
// values. Useful for dogfooding against a personal OAuth client before the
// production one is verified.

// Filled in once Phase 1 (GCP project + OAuth client creation under the
// cluster-software Google account) completes. Until then the env-var
// override path is the only viable one — bundled values intentionally fail
// so we notice if we ship without populating them.
const BUNDLED_CLIENT_ID = "809836098986-6rmq1log3rc5mdao58ltcr83crrnmshh.apps.googleusercontent.com";
const BUNDLED_CLIENT_SECRET = "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";

// Standard installed-app OAuth endpoints. Identical across every Google
// Desktop OAuth client; safe to hard-code.
const AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const CERT_URL = "https://www.googleapis.com/oauth2/v1/certs";
// gws negotiates an ephemeral localhost port; only the loopback redirect is
// used and Desktop clients don't require registering specific URIs.
const REDIRECT_URIS = ["http://localhost"];

export type GoogleOauthClientFile = {
  installed: {
    client_id: string;
    project_id?: string;
    auth_uri: string;
    token_uri: string;
    auth_provider_x509_cert_url: string;
    client_secret: string;
    redirect_uris: string[];
  };
};

export type ResolvedClientCredentials = {
  client_id: string;
  client_secret: string;
  source: "env" | "bundled";
};

// Resolve the credentials to use at runtime. Env vars win so contributors
// can dogfood against their own OAuth client before the production one is
// verified by Google.
export function resolveGoogleClientCredentials(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedClientCredentials | null {
  const envId = env.ACRM_GOOGLE_CLIENT_ID?.trim();
  const envSecret = env.ACRM_GOOGLE_CLIENT_SECRET?.trim();
  if (envId && envSecret) {
    return { client_id: envId, client_secret: envSecret, source: "env" };
  }
  if (BUNDLED_CLIENT_ID && BUNDLED_CLIENT_SECRET) {
    return {
      client_id: BUNDLED_CLIENT_ID,
      client_secret: BUNDLED_CLIENT_SECRET,
      source: "bundled",
    };
  }
  return null;
}

// Build the standard `client_secret.json` shape gws expects.
export function buildClientSecretJson(
  creds: ResolvedClientCredentials,
): GoogleOauthClientFile {
  return {
    installed: {
      client_id: creds.client_id,
      auth_uri: AUTH_URI,
      token_uri: TOKEN_URI,
      auth_provider_x509_cert_url: CERT_URL,
      client_secret: creds.client_secret,
      redirect_uris: REDIRECT_URIS,
    },
  };
}
