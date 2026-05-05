type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: string; code?: string };

let forced: boolean | null = null;

export function setJsonMode(on: boolean | undefined) {
  if (on === true) forced = true;
  else if (on === false) forced = false;
}

export function isJson(): boolean {
  if (forced !== null) return forced;
  return !process.stdout.isTTY;
}

export function ok<T>(data: T): void {
  if (isJson()) {
    process.stdout.write(JSON.stringify({ ok: true, data } satisfies Ok<T>) + "\n");
  } else {
    if (data === undefined || data === null) return;
    if (typeof data === "string") {
      process.stdout.write(data + "\n");
    } else {
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    }
  }
}

export function fail(error: string, code?: string): void {
  const payload: Err = { ok: false, error, ...(code ? { code } : {}) };
  if (isJson()) {
    process.stdout.write(JSON.stringify(payload) + "\n");
  } else {
    process.stderr.write(`error: ${error}${code ? ` (${code})` : ""}\n`);
  }
}
