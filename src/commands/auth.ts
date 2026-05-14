import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Command } from "commander";
import { fail, ok, setJsonMode, isJson } from "../output/json.js";
import { AcrmError, ERR } from "../lib/errors.js";
import {
  buildAuthorizationUrl,
  generatePkcePair,
  generateState,
} from "../lib/oauth-pkce.js";
import {
  writeToken,
  tokenCachePath,
  type CachedToken,
} from "../lib/token-cache.js";
import { PROVIDERS } from "../integrations/providers.js";
import type { TranscriptProvider } from "../integrations/provider.js";

type AuthMetadata = {
  authorization_endpoint?: string;
  token_endpoint?: string;
};

type AuthOpts = {
  token?: string;
};

type AuthResult = { provider: string; cached_at: string; file: string };

export function registerAuth(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage cached credentials for transcript providers.");

  for (const provider of PROVIDERS) {
    if (!provider.oauth) continue;
    registerProviderAuth(auth, program, provider);
  }
}

function registerProviderAuth(
  auth: Command,
  program: Command,
  provider: TranscriptProvider,
): void {
  auth
    .command(provider.name)
    .description(
      `Authenticate with ${provider.label} and cache the OAuth token at ~/.config/acrm/${provider.name}.json. Runs OAuth 2.0 with PKCE against the provider's discovery document. Pass \`--token <token>\` to skip the browser flow and cache an existing token directly.`,
    )
    .option(
      "--token <token>",
      "skip the OAuth flow and cache this access token verbatim",
    )
    .action(async (opts: AuthOpts) => {
      const root = program.opts() as { json?: boolean };
      setJsonMode(root.json);
      try {
        const result = opts.token
          ? await persistTokenLiteral(provider, opts.token)
          : await runProviderOAuth(provider);
        ok(result);
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });
}

async function persistTokenLiteral(
  provider: TranscriptProvider,
  raw: string,
): Promise<AuthResult> {
  const token = raw.trim();
  if (!token) {
    throw new AcrmError("--token cannot be empty", ERR.INVALID_INPUT);
  }
  const cached: CachedToken = {
    provider: provider.name,
    access_token: token,
    token_type: "Bearer",
  };
  const file = await writeToken(cached);
  return { provider: provider.name, cached_at: new Date().toISOString(), file };
}

async function runProviderOAuth(
  provider: TranscriptProvider,
): Promise<AuthResult> {
  const oauth = provider.oauth;
  if (!oauth) {
    throw new AcrmError(
      `${provider.name} is not configured for OAuth`,
      ERR.INVALID_INPUT,
    );
  }

  const discovery = await fetchDiscovery(oauth.discoveryUrl);
  if (!discovery.authorization_endpoint || !discovery.token_endpoint) {
    throw new AcrmError(
      `${provider.label} discovery doc missing authorization/token endpoints`,
      ERR.IMPORT,
      `if ${provider.label} hasn't published OAuth metadata yet, run \`acrm auth ${provider.name} --token <token>\` with a token you obtained out-of-band`,
    );
  }

  const pkce = generatePkcePair();
  const state = generateState();

  const { port, captured } = await startCallbackServer(state);
  const redirect_uri = `http://127.0.0.1:${port}/callback`;
  const url = buildAuthorizationUrl({
    authorization_endpoint: discovery.authorization_endpoint,
    client_id: oauth.clientId,
    redirect_uri,
    scope: oauth.scope || undefined,
    state,
    code_challenge: pkce.code_challenge,
  });

  if (!isJson()) {
    process.stderr.write(
      `\nOpen this URL in your browser to authorize:\n\n  ${url}\n\nWaiting for the callback…\n`,
    );
  }

  const code = await captured;
  const tokenResp = await exchangeCodeForToken({
    token_endpoint: discovery.token_endpoint,
    code,
    redirect_uri,
    code_verifier: pkce.code_verifier,
    client_id: oauth.clientId,
  });

  const expires_at =
    typeof tokenResp.expires_in === "number"
      ? Math.floor(Date.now() / 1000) + tokenResp.expires_in
      : undefined;

  const cached: CachedToken = {
    provider: provider.name,
    access_token: tokenResp.access_token,
    token_type: tokenResp.token_type ?? "Bearer",
    refresh_token: tokenResp.refresh_token,
    scope: tokenResp.scope,
    expires_at,
    authorization_endpoint: discovery.authorization_endpoint,
    token_endpoint: discovery.token_endpoint,
  };
  const file = await writeToken(cached);
  return { provider: provider.name, cached_at: new Date().toISOString(), file };
}

async function fetchDiscovery(url: string): Promise<AuthMetadata> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new AcrmError(
      `failed to reach OAuth discovery doc at ${url}: ${e instanceof Error ? e.message : String(e)}`,
      ERR.IMPORT,
      "if you already have a token, pass --token <token> to skip the browser flow",
    );
  }
  if (!res.ok) {
    throw new AcrmError(
      `OAuth discovery doc at ${url} returned HTTP ${res.status}`,
      ERR.IMPORT,
      "if you already have a token, pass --token <token> to skip the browser flow",
    );
  }
  return (await res.json()) as AuthMetadata;
}

type TokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

async function exchangeCodeForToken(input: {
  token_endpoint: string;
  code: string;
  redirect_uri: string;
  code_verifier: string;
  client_id: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirect_uri,
    client_id: input.client_id,
    code_verifier: input.code_verifier,
  });
  const res = await fetch(input.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new AcrmError(
      `token exchange failed: HTTP ${res.status} ${text.slice(0, 200)}`,
      ERR.IMPORT,
    );
  }
  try {
    return JSON.parse(text) as TokenResponse;
  } catch (e) {
    throw new AcrmError(
      `token exchange returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      ERR.IMPORT,
    );
  }
}

function startCallbackServer(
  state: string,
): Promise<{ port: number; captured: Promise<string> }> {
  return new Promise((resolveOuter, rejectOuter) => {
    const server = createServer();
    const captured: Promise<string> = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          server.close();
          reject(
            new AcrmError(
              "timed out waiting for OAuth callback (5 min)",
              ERR.IMPORT,
            ),
          );
        },
        5 * 60 * 1000,
      );

      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const code = url.searchParams.get("code");
        const cbState = url.searchParams.get("state");
        const err = url.searchParams.get("error");
        if (err) {
          res.statusCode = 400;
          res.end(`auth error: ${err}`);
          clearTimeout(timeout);
          server.close();
          reject(new AcrmError(`provider returned error: ${err}`, ERR.IMPORT));
          return;
        }
        if (!code || cbState !== state) {
          res.statusCode = 400;
          res.end("invalid callback");
          clearTimeout(timeout);
          server.close();
          reject(
            new AcrmError(
              "OAuth callback was missing code or state mismatched",
              ERR.IMPORT,
            ),
          );
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          "<!doctype html><meta charset='utf-8'><title>acrm</title><p>Authorized. You can close this tab.</p>",
        );
        clearTimeout(timeout);
        server.close();
        resolve(code);
      });
    });
    server.on("error", (e) => rejectOuter(e));
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolveOuter({ port, captured });
    });
  });
}

// Re-export for tests.
export { tokenCachePath };
