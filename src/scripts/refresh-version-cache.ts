// Detached worker spawned by src/lib/update-check.ts. Fetches the latest
// published version from the npm registry and writes the cache file.
//
// Hard rule: this script must never throw. All errors are swallowed.
// It also has a short timeout so a slow registry never leaves orphaned
// background processes lingering on the user's machine.
import { writeCache } from "../lib/update-check.js";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const PACKAGE_NAME = "@agent-crm/cli";
const TIMEOUT_MS = 5000;

async function main(): Promise<void> {
  const base = process.env.ACRM_REGISTRY_URL?.trim() || DEFAULT_REGISTRY;
  // /<pkg>/latest returns the dist-tag manifest with `version` at the root.
  const url = `${base.replace(/\/+$/, "")}/${encodeURIComponent(
    PACKAGE_NAME,
  )}/latest`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string" || !body.version) return;
    writeCache(body.version);
  } catch {
    // Network error, abort, malformed JSON — all silently ignored.
  } finally {
    clearTimeout(timer);
  }
}

main().catch(() => {
  /* never throw out of a detached child */
});
