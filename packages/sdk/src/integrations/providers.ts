import type { TranscriptProvider } from "./provider.js";
import { granolaProvider } from "./granola.js";

// The full registry of native transcript providers. Adding a new one is a
// single line here plus a `src/integrations/<name>.ts` file that exports a
// TranscriptProvider value.
export const PROVIDERS: readonly TranscriptProvider[] = [granolaProvider];

export function getProvider(name: string): TranscriptProvider | undefined {
  const lower = name.toLowerCase();
  return PROVIDERS.find((p) => p.name === lower);
}

export function providerNames(): string[] {
  return PROVIDERS.map((p) => p.name);
}
