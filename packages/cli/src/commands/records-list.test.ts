import { afterEach, describe, expect, it, vi } from "vitest";
import { __test as recordsCommandTest } from "./records.js";

describe("records list command", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("requires a desktop cloud session", () => {
    expect(() => recordsCommandTest.requireCloudSession()).toThrow(/cloud desktop session/);
  });

  it("sends record search options to the sync engine", async () => {
    vi.stubEnv("ACRM_SYNC_ENGINE_URL", "https://sync.example.com");
    vi.stubEnv("ACRM_CLOUD_WORKSPACE_ID", "workspace-1");
    vi.stubEnv("ACRM_CLOUD_ORG_ID", "org-1");
    vi.stubEnv("ACRM_DESKTOP_SESSION_TOKEN", "desktop-token");
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      objectSlug: "companies",
      records: [
        {
          object_slug: "companies",
          record_id: "company-1",
          label: "Kubby",
          subtitle: "",
          values: []
        }
      ],
      limit: 5,
      cursor: null,
      nextCursor: null,
      hasMore: false,
      totalMatches: 1
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await recordsCommandTest.runRecordsList("companies", {
      search: "Kubby",
      limit: "5",
      value: ["name", "domains"],
      secondaryLabels: false
    });

    expect(result).toEqual({
      objectSlug: "companies",
      records: [
        {
          object_slug: "companies",
          record_id: "company-1",
          label: "Kubby",
          subtitle: "",
          values: []
        }
      ],
      limit: 5,
      cursor: null,
      nextCursor: null,
      hasMore: false,
      totalMatches: 1
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsedUrl = new URL(url);
    expect(parsedUrl.origin + parsedUrl.pathname).toBe("https://sync.example.com/app/workspace/records");
    expect(parsedUrl.searchParams.get("object_slug")).toBe("companies");
    expect(parsedUrl.searchParams.get("limit")).toBe("5");
    expect(parsedUrl.searchParams.get("search_query")).toBe("Kubby");
    expect(parsedUrl.searchParams.get("value_attributes")).toBe("name,domains");
    expect(parsedUrl.searchParams.get("include_secondary_labels")).toBe("false");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer desktop-token");
  });

  it("validates limits before calling the sync engine", () => {
    expect(recordsCommandTest.parseRecordListLimit(undefined)).toBe(25);
    expect(() => recordsCommandTest.parseRecordListLimit("0")).toThrow(/invalid --limit/);
    expect(() => recordsCommandTest.parseRecordListLimit("251")).toThrow(/invalid --limit/);
  });
});
