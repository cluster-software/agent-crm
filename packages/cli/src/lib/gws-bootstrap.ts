import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
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

// Drive `gws auth login -s people` ourselves so the user sees one browser
// pop-up and that's it — no separate command for them to remember.
//
// gws prints status text ("Your browser has been opened…") to stdout. We
// must not let that leak into acrm's stdout, because acrm reserves stdout
// for its own JSON output and downstream parsers see anything-else-on-stdout
// as malformed JSON. Route gws output to our stderr instead.
export async function runGwsAuthLogin(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("gws", ["auth", "login", "-s", "people"], {
      stdio: ["inherit", "pipe", "inherit"],
    });
    child.stdout?.on("data", (b: Buffer) => process.stderr.write(b));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new AcrmError(
            `gws auth login exited with code ${code}`,
            ERR.INVALID_INPUT,
            "the browser-based OAuth flow did not complete. try running `gws auth login -s people` directly to see the full error.",
          ),
        );
    });
  });
}
