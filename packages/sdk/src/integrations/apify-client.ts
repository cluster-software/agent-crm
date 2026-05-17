import { AcrmError, ERR } from "../lib/errors.js";

export async function callApifyDatasetItem<T>(
  input: {
    actor: string;
    token: string;
    body: Record<string, unknown>;
    timeoutMs?: number;
    notFoundMessage: string;
  },
): Promise<T> {
  const params = new URLSearchParams({
    token: input.token,
    maxTotalChargeUsd: "1.00",
  });
  const endpoint =
    `https://api.apify.com/v2/acts/${input.actor}/run-sync-get-dataset-items`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? 180_000,
  );
  let resp: Response;
  try {
    resp = await fetch(`${endpoint}?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AcrmError(`apify network error: ${msg}`, ERR.UNHANDLED);
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 500);
    throw new AcrmError(`apify http ${resp.status}: ${body}`, ERR.UNHANDLED);
  }

  const data = (await resp.json()) as T[];
  if (!Array.isArray(data) || data.length === 0) {
    throw new AcrmError(input.notFoundMessage, ERR.NOT_FOUND);
  }
  return data[0]!;
}
