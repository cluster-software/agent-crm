import { describe, expect, it, vi } from "vitest";
import {
  normalizeIdentifiers,
  resolvePersonByIdentifiers,
  type IdentifierAttribute,
  type Lookup,
} from "@agent-crm/sdk";

function makeLookup(
  table: Partial<Record<IdentifierAttribute, Record<string, string>>>,
): { fn: Lookup; calls: { attr: IdentifierAttribute; key: string }[] } {
  const calls: { attr: IdentifierAttribute; key: string }[] = [];
  const fn: Lookup = async (attr, key) => {
    calls.push({ attr, key });
    return table[attr]?.[key] ?? null;
  };
  return { fn, calls };
}

describe("normalizeIdentifiers", () => {
  it("lowercases and trims emails, requires @, dedupes", () => {
    expect(
      normalizeIdentifiers({
        emails: ["  Alice@Example.com ", "alice@example.com", "no-at"],
      }),
    ).toEqual({
      emails: ["alice@example.com"],
      linkedin_url: null,
      twitter_url: null,
    });
  });

  it("accepts a single `email` field for transcript callers", () => {
    expect(normalizeIdentifiers({ email: "Bob@Acme.com" })).toEqual({
      emails: ["bob@acme.com"],
      linkedin_url: null,
      twitter_url: null,
    });
  });

  it("merges `email` and `emails` without duplicates", () => {
    expect(
      normalizeIdentifiers({
        email: "shared@x.com",
        emails: ["shared@x.com", "other@x.com"],
      }),
    ).toEqual({
      emails: ["shared@x.com", "other@x.com"],
      linkedin_url: null,
      twitter_url: null,
    });
  });

  it("normalizes linkedin and twitter URLs", () => {
    expect(
      normalizeIdentifiers({
        linkedin_url: "https://www.LinkedIn.com/in/Foo/?utm=1",
        twitter_url: "@Bar",
      }),
    ).toEqual({
      emails: [],
      linkedin_url: "linkedin.com/in/foo",
      twitter_url: "x.com/bar",
    });
  });

  it("returns null for whitespace-only urls", () => {
    expect(
      normalizeIdentifiers({ linkedin_url: "   ", twitter_url: "   " }),
    ).toEqual({ emails: [], linkedin_url: null, twitter_url: null });
  });
});

describe("resolvePersonByIdentifiers", () => {
  it("matches by email and short-circuits before linkedin/twitter", async () => {
    const { fn, calls } = makeLookup({
      email_addresses: { "alice@acme.com": "person-1" },
      linkedin_url: { "linkedin.com/in/alice": "person-2" }, // wrong record
    });
    const result = await resolvePersonByIdentifiers(fn, {
      email: "alice@acme.com",
      linkedin_url: "linkedin.com/in/alice",
    });
    expect(result.person_record_id).toBe("person-1");
    expect(result.matched_by).toBe("email_addresses");
    expect(result.tried).toEqual(["email_addresses"]);
    // Cascade stopped after the email hit — linkedin/twitter never probed.
    expect(calls).toEqual([
      { attr: "email_addresses", key: "alice@acme.com" },
    ]);
  });

  it("falls through to linkedin when email misses", async () => {
    const { fn, calls } = makeLookup({
      linkedin_url: { "linkedin.com/in/bob": "person-2" },
    });
    const result = await resolvePersonByIdentifiers(fn, {
      email: "ghost@nowhere.com",
      linkedin_url: "linkedin.com/in/bob",
    });
    expect(result.person_record_id).toBe("person-2");
    expect(result.matched_by).toBe("linkedin_url");
    expect(result.tried).toEqual(["email_addresses", "linkedin_url"]);
    expect(calls.map((c) => c.attr)).toEqual([
      "email_addresses",
      "linkedin_url",
    ]);
  });

  it("falls through to twitter when email and linkedin miss", async () => {
    const { fn } = makeLookup({
      twitter_url: { "x.com/carol": "person-3" },
    });
    const result = await resolvePersonByIdentifiers(fn, {
      email: "ghost@nowhere.com",
      linkedin_url: "linkedin.com/in/ghost",
      twitter_url: "@carol",
    });
    expect(result.person_record_id).toBe("person-3");
    expect(result.matched_by).toBe("twitter_url");
    expect(result.matched_key).toBe("x.com/carol");
    expect(result.tried).toEqual([
      "email_addresses",
      "linkedin_url",
      "twitter_url",
    ]);
  });

  it("returns null with reason context when nothing matches", async () => {
    const { fn } = makeLookup({});
    const result = await resolvePersonByIdentifiers(fn, {
      email: "ghost@nowhere.com",
      linkedin_url: "linkedin.com/in/ghost",
    });
    expect(result.person_record_id).toBeNull();
    expect(result.matched_by).toBeNull();
    expect(result.tried).toEqual(["email_addresses", "linkedin_url"]);
  });

  it("treats no identifiers as `tried: []` (caller distinguishes reason)", async () => {
    const lookup = vi.fn();
    const result = await resolvePersonByIdentifiers(lookup, {});
    expect(result.person_record_id).toBeNull();
    expect(result.tried).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("ignores identifiers that normalize to null (only @-bearing emails count)", async () => {
    const lookup = vi.fn();
    const result = await resolvePersonByIdentifiers(lookup, {
      email: "no-at-sign",
    });
    expect(result.person_record_id).toBeNull();
    expect(result.tried).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("tries every email before falling through", async () => {
    const { fn, calls } = makeLookup({
      email_addresses: { "second@acme.com": "person-1" },
    });
    const result = await resolvePersonByIdentifiers(fn, {
      emails: ["first@acme.com", "second@acme.com"],
      linkedin_url: "linkedin.com/in/x",
    });
    expect(result.person_record_id).toBe("person-1");
    expect(result.matched_key).toBe("second@acme.com");
    expect(calls.map((c) => c.key)).toEqual([
      "first@acme.com",
      "second@acme.com",
    ]);
  });
});
