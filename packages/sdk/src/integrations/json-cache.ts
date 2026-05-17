import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_JSON_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export async function readFreshJsonCache<T>(
  cachePath: string,
  ttlMs = DEFAULT_JSON_CACHE_TTL_MS,
): Promise<T | null> {
  let s;
  try {
    s = await stat(cachePath);
  } catch {
    return null;
  }
  if (Date.now() - s.mtimeMs > ttlMs) return null;

  try {
    const raw = await readFile(cachePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJsonCache<T>(
  cachePath: string,
  value: T,
): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(value, null, 2), "utf8");
}
