import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AcrmError,
  ERR,
  buildClientSecretJson,
  resolveGoogleClientCredentials,
} from "@agent-crm/sdk";

// Where gws stores its config — honors GOOGLE_WORKSPACE_CLI_CONFIG_DIR for
// sandboxed test setups, otherwise the default ~/.config/gws.
export function resolveGwsConfigDir(): string {
  return process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR || join(homedir(), ".config", "gws");
}

// Ensure ~/.config/gws/client_secret.json exists. We bundle acrm's own
// OAuth client into the SDK so end users never have to create one. If a
// client_secret.json is already present (user brought their own, or a prior
// run wrote ours), leave it alone.
export function ensureBundledClientSecret(): { wrote: boolean; path: string } {
  const dir = resolveGwsConfigDir();
  const path = join(dir, "client_secret.json");
  if (existsSync(path)) return { wrote: false, path };

  const creds = resolveGoogleClientCredentials();
  if (!creds) {
    throw new AcrmError(
      "no Google OAuth client available",
      ERR.INVALID_INPUT,
      "this build of acrm was published without bundled OAuth credentials. set ACRM_GOOGLE_CLIENT_ID and ACRM_GOOGLE_CLIENT_SECRET in your environment to use your own, or upgrade acrm.",
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(buildClientSecretJson(creds), null, 2),
    { mode: 0o600 },
  );
  return { wrote: true, path };
}

// Scopes we request when driving the OAuth flow. These match what's
// pre-approved on the consent screen of acrm's production OAuth client.
// `-s` in gws is a SERVICE filter, not a scope list — use `--scopes` with
// the full URLs.
const PEOPLE_SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
].join(",");

// Matches the Google OAuth consent URL gws prints when it can't auto-open a
// browser (e.g. when stdout isn't a real terminal — Claude Code's Bash tool,
// CI, ssh sessions without $BROWSER, etc).
const AUTH_URL_REGEX = /https:\/\/accounts\.google\.com\/o\/oauth2\/\S+/;

// Stable path so skills / wrappers can read the URL back without parsing
// streamed stderr. Overwritten on each auth attempt.
export const AUTH_URL_FILE = join(tmpdir(), "acrm-auth-url.txt");

// Drive `gws auth login --scopes=...` ourselves so the user sees one
// browser pop-up and that's it — no separate command for them to remember.
//
// gws prints status text ("Your browser has been opened…") to stdout. We
// must not let that leak into acrm's stdout, because acrm reserves stdout
// for its own JSON output and downstream parsers see anything-else-on-stdout
// as malformed JSON. Route gws output to our stderr instead.
//
// When the URL appears in the stream we ALSO emit a clearly-delimited banner
// and write the URL to a temp file. Without the banner, long URLs get
// truncated in Claude Code's tool-output renderer and the user can't click
// them; the file gives skills a stable place to read the URL from.
export async function runGwsAuthLogin(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "gws",
      ["auth", "login", "--scopes", PEOPLE_SCOPES],
      {
        stdio: ["inherit", "pipe", "inherit"],
      },
    );
    let buffer = "";
    let urlEmitted = false;
    child.stdout?.on("data", (b: Buffer) => {
      const chunk = b.toString("utf8");
      buffer += chunk;
      if (!urlEmitted) {
        const m = buffer.match(AUTH_URL_REGEX);
        if (m) {
          const url = m[0];
          urlEmitted = true;
          try {
            writeFileSync(AUTH_URL_FILE, url + "\n", { mode: 0o600 });
          } catch {
            // best-effort; auth still works if the file write fails
          }
          process.stderr.write(
            `\n===== ACRM AUTH URL =====\n${url}\n(also saved to ${AUTH_URL_FILE})\n=========================\n\n`,
          );
        }
      }
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new AcrmError(
            `gws auth login exited with code ${code}`,
            ERR.INVALID_INPUT,
            `the browser-based OAuth flow did not complete. try running \`gws auth login --scopes=${PEOPLE_SCOPES}\` directly to see the full error.`,
          ),
        );
    });
  });
}
