import { uuidv7 } from "./uuidv7.js";

// Kept as async (with an unused db parameter) so existing call sites don't
// change. Generating UUIDv7 in-process saves one SQL round-trip per record/value
// — the dominant cost during bulk imports.
export async function generateUuid(_db?: unknown): Promise<string> {
  return uuidv7();
}
