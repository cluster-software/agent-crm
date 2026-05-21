import { describe, expect, it } from "vitest";
import { __test } from "./gws-contacts.js";

const { extractContacts, normalizePerson } = __test;

// Fixtures mirror the shape Google's People API returns. They're the bits
// of the response we actually consume — keep them realistic so a Google
// API change shows up here first.

describe("normalizePerson", () => {
  it("returns null for non-object input", () => {
    expect(normalizePerson(null, "connections")).toBeNull();
    expect(normalizePerson("oops", "connections")).toBeNull();
    expect(normalizePerson(123, "connections")).toBeNull();
  });

  it("returns null when resourceName is missing", () => {
    expect(
      normalizePerson(
        { names: [{ displayName: "Anon" }] },
        "connections",
      ),
    ).toBeNull();
  });

  it("picks displayName from the primary entry, not the first", () => {
    const c = normalizePerson(
      {
        resourceName: "people/c1",
        names: [
          { displayName: "Alt Name" },
          { displayName: "Primary Name", metadata: { primary: true } },
        ],
      },
      "connections",
    );
    expect(c?.display_name).toBe("Primary Name");
  });

  it("falls back to first name when no primary is flagged", () => {
    const c = normalizePerson(
      {
        resourceName: "people/c2",
        names: [{ displayName: "Only One" }],
      },
      "connections",
    );
    expect(c?.display_name).toBe("Only One");
  });

  it("composes given+family when displayName is missing", () => {
    const c = normalizePerson(
      {
        resourceName: "people/c3",
        names: [{ givenName: "Jane", familyName: "Doe" }],
      },
      "connections",
    );
    expect(c?.display_name).toBe("Jane Doe");
  });

  it("composes from just givenName when familyName is missing", () => {
    const c = normalizePerson(
      {
        resourceName: "people/c4",
        names: [{ givenName: "Madonna" }],
      },
      "connections",
    );
    expect(c?.display_name).toBe("Madonna");
  });

  it("returns null display_name when names entries are empty objects", () => {
    const c = normalizePerson(
      { resourceName: "people/c5", names: [{}] },
      "connections",
    );
    expect(c?.display_name).toBeNull();
  });

  it("primary email goes first in emails[] regardless of array order", () => {
    const c = normalizePerson(
      {
        resourceName: "people/c6",
        emailAddresses: [
          { value: "work@acme.com" },
          { value: "personal@acme.com", metadata: { primary: true } },
          { value: "other@acme.com" },
        ],
      },
      "connections",
    );
    expect(c?.emails).toEqual([
      "personal@acme.com",
      "work@acme.com",
      "other@acme.com",
    ]);
  });

  it("filters out non-string and whitespace-only email entries", () => {
    const c = normalizePerson(
      {
        resourceName: "people/c7",
        emailAddresses: [
          { value: "real@acme.com" },
          { value: "   " },
          { value: 42 },
          { notValue: "ignored" },
          "junk-not-an-object",
          null,
        ],
      },
      "connections",
    );
    expect(c?.emails).toEqual(["real@acme.com"]);
  });

  it("sorts organizations with current:true first, regardless of array order", () => {
    const c = normalizePerson(
      {
        resourceName: "people/c8",
        organizations: [
          { name: "Old Co", title: "former gig" },
          { name: "Current Co", title: "today", current: true },
          { name: "Older Co", title: "ancient" },
        ],
      },
      "connections",
    );
    expect(c?.organizations?.[0]?.name).toBe("Current Co");
    expect(c?.organizations?.[0]?.title).toBe("today");
  });

  it("preserves order when no organization is flagged current", () => {
    const c = normalizePerson(
      {
        resourceName: "people/c9",
        organizations: [
          { name: "First Co" },
          { name: "Second Co" },
        ],
      },
      "connections",
    );
    expect(c?.organizations?.map((o) => o.name)).toEqual([
      "First Co",
      "Second Co",
    ]);
  });

  it("collects URLs without primary-first reordering", () => {
    // primaryFirst=false for urls — keep source order so the LinkedIn vs X
    // sniffers see them as the user listed them.
    const c = normalizePerson(
      {
        resourceName: "people/c10",
        urls: [
          { value: "https://example.com" },
          { value: "https://linkedin.com/in/foo", metadata: { primary: true } },
        ],
      },
      "connections",
    );
    expect(c?.urls).toEqual([
      "https://example.com",
      "https://linkedin.com/in/foo",
    ]);
  });

  it("survives missing arrays — emails/phones/urls/organizations all default to empty", () => {
    const c = normalizePerson(
      { resourceName: "people/c11" },
      "other_contacts",
    );
    expect(c?.emails).toEqual([]);
    expect(c?.phones).toEqual([]);
    expect(c?.urls).toEqual([]);
    expect(c?.organizations).toEqual([]);
    expect(c?.display_name).toBeNull();
    expect(c?.origin).toBe("other_contacts");
  });
});

describe("extractContacts", () => {
  it("reads from `connections` when origin is connections", () => {
    const page = {
      connections: [
        { resourceName: "people/a", names: [{ displayName: "A" }] },
        { resourceName: "people/b", names: [{ displayName: "B" }] },
      ],
      otherContacts: [
        { resourceName: "people/should-not-see", names: [{ displayName: "X" }] },
      ],
    };
    const out = Array.from(extractContacts(page, "connections"));
    expect(out.map((c) => c.resource_name)).toEqual([
      "people/a",
      "people/b",
    ]);
  });

  it("reads from `otherContacts` when origin is other_contacts", () => {
    const page = {
      otherContacts: [
        { resourceName: "people/o1", names: [{ displayName: "O1" }] },
      ],
    };
    const out = Array.from(extractContacts(page, "other_contacts"));
    expect(out).toHaveLength(1);
    expect(out[0]?.resource_name).toBe("people/o1");
    expect(out[0]?.origin).toBe("other_contacts");
  });

  it("yields nothing when the expected key is absent (e.g. empty page response)", () => {
    expect(Array.from(extractContacts({}, "connections"))).toHaveLength(0);
    expect(
      Array.from(extractContacts({ nextPageToken: "abc" }, "connections")),
    ).toHaveLength(0);
  });

  it("yields nothing for non-object pages", () => {
    expect(Array.from(extractContacts(null, "connections"))).toHaveLength(0);
    expect(Array.from(extractContacts("string", "connections"))).toHaveLength(0);
    expect(Array.from(extractContacts(42, "connections"))).toHaveLength(0);
  });

  it("skips entries that don't normalize (e.g. missing resourceName)", () => {
    const page = {
      connections: [
        { resourceName: "people/keep", names: [{ displayName: "K" }] },
        { names: [{ displayName: "no resource name" }] },
        null,
        "garbage",
      ],
    };
    const out = Array.from(extractContacts(page, "connections"));
    expect(out).toHaveLength(1);
    expect(out[0]?.resource_name).toBe("people/keep");
  });
});
