import { homedir } from "node:os";
import path from "node:path";

// Resolve the acrm config dir for CLI invocations. Honors ACRM_CONFIG_DIR if
// set, otherwise falls back to `~/.config/acrm`. CLI-only — the SDK accepts
// an explicit `configDir` argument and never reads process.env directly.
export function acrmConfigDir(): string {
  const override = process.env.ACRM_CONFIG_DIR?.trim();
  if (override && override.length) return override;
  return path.join(homedir(), ".config", "acrm");
}
