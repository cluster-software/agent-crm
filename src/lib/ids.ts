import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(): string {
  const time = Date.now();
  let timeStr = "";
  let t = time;
  for (let i = 0; i < 10; i++) {
    timeStr = ALPHABET[t % 32]! + timeStr;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(10);
  let randStr = "";
  for (let i = 0; i < 16; i++) {
    const byteIdx = Math.floor((i * 5) / 8);
    const bitOffset = (i * 5) % 8;
    const hi = rand[byteIdx]! << 8;
    const lo = byteIdx + 1 < rand.length ? rand[byteIdx + 1]! : 0;
    const combined = hi | lo;
    const shifted = (combined >> (16 - bitOffset - 5)) & 0x1f;
    randStr += ALPHABET[shifted];
  }
  return timeStr + randStr;
}

export function recordId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
