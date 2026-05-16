import { randomBytes } from "node:crypto";

// UUIDv7: 48-bit unix-ms timestamp, 4-bit version, 12-bit rand_a, 2-bit
// variant, 62-bit rand_b. Layout: xxxxxxxx-xxxx-7xxx-Yxxx-xxxxxxxxxxxx (Y in 8..b).
// We track the last timestamp + counter so two UUIDs minted in the same ms still
// sort monotonically — important when rows insert faster than 1ms apart.
let lastMs = 0;
let lastCounter = 0;

export function uuidv7(): string {
  let ms = Date.now();
  if (ms === lastMs) {
    lastCounter++;
    if (lastCounter > 0x0fff) {
      // overflowed the 12-bit rand_a slot; bump the clock to keep monotonic
      ms++;
      lastMs = ms;
      lastCounter = 0;
    }
  } else if (ms < lastMs) {
    // clock went backwards (NTP, etc.) — pin to lastMs
    ms = lastMs;
    lastCounter++;
  } else {
    lastMs = ms;
    lastCounter = 0;
  }
  const rand = randomBytes(8);
  // bytes 0..5: timestamp big-endian
  const msHex = ms.toString(16).padStart(12, "0");
  // bytes 6..7: version (4 bits) + rand_a (12 bits) — we use lastCounter for rand_a
  const verAndCounter = (0x7000 | (lastCounter & 0x0fff)).toString(16).padStart(4, "0");
  // bytes 8..9: variant (2 bits = 10) + 14 bits random
  const variantByte = ((rand[0]! & 0x3f) | 0x80).toString(16).padStart(2, "0");
  const r9 = rand[1]!.toString(16).padStart(2, "0");
  // bytes 10..15: 48 bits random
  const tail = Array.from(rand.slice(2, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${msHex.slice(0, 8)}-${msHex.slice(8, 12)}-${verAndCounter}-${variantByte}${r9}-${tail}`;
}
