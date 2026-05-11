import type { Lix } from "@lix-js/sdk";
import { uuidv7 } from "./uuidv7.js";

// Kept as async (with an unused Lix parameter) so existing call sites don't
// change. Generating UUIDv7 in-process saves one SQL round-trip per record/value
// — the dominant cost during bulk imports.
export async function generateUuid(_lix: Lix): Promise<string> {
  return uuidv7();
}
