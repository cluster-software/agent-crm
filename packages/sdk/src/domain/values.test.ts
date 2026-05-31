import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { normalizeLookupKey, normalizeUniqueKey } from "./values.js";

describe("normalized keys", () => {
  it("keeps short text and URL keys readable", () => {
    expect(normalizeUniqueKey("text", { value: "Example" })).toBe("Example");
    expect(normalizeUniqueKey("url", { value: "HTTPS://EXAMPLE.COM/A" })).toBe(
      "https://example.com/a",
    );
  });

  it("hashes oversized text and URL keys with the same representation used for lookups", () => {
    const longText = "x".repeat(6_000);
    const longUrl = `https://example.com/${"path".repeat(2_000)}`;

    const textKey = normalizeUniqueKey("text", { value: longText });
    const urlKey = normalizeUniqueKey("url", { value: longUrl });

    expect(textKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(urlKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Buffer.byteLength(textKey!, "utf8")).toBeLessThan(1024);
    expect(Buffer.byteLength(urlKey!, "utf8")).toBeLessThan(1024);
    expect(normalizeLookupKey(longText)).toBe(textKey);
    expect(normalizeLookupKey(longUrl.toLowerCase())).toBe(urlKey);
  });
});
