import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type CachedToken = {
  provider: string;
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  // Populated when the auth flow obtained the client via RFC 7591 Dynamic
  // Client Registration. Reused on refresh so we don't have to re-register.
  client_id?: string;
  client_secret?: string;
  registration_endpoint?: string;
};

export function tokenCacheDir(): string {
  if (process.env.ACRM_CONFIG_DIR && process.env.ACRM_CONFIG_DIR.trim().length) {
    return process.env.ACRM_CONFIG_DIR;
  }
  return path.join(homedir(), ".config", "acrm");
}

export function tokenCachePath(provider: string): string {
  return path.join(tokenCacheDir(), `${provider}.json`);
}

export async function readToken(
  provider: string,
): Promise<CachedToken | null> {
  const file = tokenCachePath(provider);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as CachedToken;
    if (
      !parsed ||
      typeof parsed.access_token !== "string" ||
      !parsed.access_token.length
    ) {
      return null;
    }
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeToken(token: CachedToken): Promise<string> {
  const dir = tokenCacheDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = tokenCachePath(token.provider);
  await writeFile(file, JSON.stringify(token, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  // writeFile honors mode only on create — chmod ensures rewrites stay tight.
  await chmod(file, 0o600);
  return file;
}

export function isExpired(token: CachedToken, skewSeconds = 30): boolean {
  if (!token.expires_at) return false;
  return Date.now() / 1000 + skewSeconds >= token.expires_at;
}
