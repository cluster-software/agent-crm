import { describe, expect, it } from "vitest";
import {
  extractMeeting,
  extractTranscriptContent,
  fetchGranolaTranscript,
  parseGranolaMeetingsXml,
  parseParticipantsText,
} from "./granola.js";
import { McpHttpClient } from "./mcp-http-client.js";

function mockFetchSequence(
  responses: Array<unknown | string>,
): typeof fetch {
  let i = 0;
  return (async () => {
    const next = responses[i++];
    if (next == null) {
      throw new Error("mock fetch ran out of responses");
    }
    const body =
      typeof next === "string" ? next : JSON.stringify(next);
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("extractTranscriptContent", () => {
  it("accepts a bare string", () => {
    expect(extractTranscriptContent("hello world")).toBe("hello world");
  });

  it("reads .content / .transcript / .text in priority order", () => {
    expect(extractTranscriptContent({ content: "from content" })).toBe(
      "from content",
    );
    expect(extractTranscriptContent({ transcript: "from transcript" })).toBe(
      "from transcript",
    );
    expect(extractTranscriptContent({ text: "from text" })).toBe(
      "from text",
    );
  });

  it("unwraps nested { transcript: { content } }", () => {
    expect(
      extractTranscriptContent({ transcript: { content: "nested" } }),
    ).toBe("nested");
  });

  it("throws when no field carries the transcript", () => {
    expect(() => extractTranscriptContent({ irrelevant: "x" })).toThrow(
      /transcript response did not include/,
    );
  });
});

describe("extractMeeting", () => {
  it("matches the meeting id case-insensitively and extracts fields", () => {
    const raw = {
      meetings: [
        {
          id: "ABC-123",
          title: "Sync with Luis",
          start_time: "2026-05-13T15:00:00Z",
          end_time: "2026-05-13T15:30:00Z",
          duration_seconds: 1800,
          summary: "talked shop",
          participants: [
            { email: "luis@hello-cluster.com" },
            { linkedin_url: "linkedin.com/in/foo" },
          ],
        },
      ],
    };
    const m = extractMeeting(raw, "abc-123");
    expect(m.id).toBe("ABC-123");
    expect(m.title).toBe("Sync with Luis");
    expect(m.start).toBe("2026-05-13T15:00:00Z");
    expect(m.end).toBe("2026-05-13T15:30:00Z");
    expect(m.duration).toBe(1800);
    expect(m.summary).toBe("talked shop");
    expect(m.participants).toEqual([
      { email: "luis@hello-cluster.com" },
      { linkedin_url: "linkedin.com/in/foo" },
    ]);
  });

  it("falls back to attendees if no participants list", () => {
    const m = extractMeeting(
      {
        meetings: [
          {
            id: "m1",
            attendees: [{ email: "a@b.com" }, { not_an_identifier: "x" }],
          },
        ],
      },
      "m1",
    );
    expect(m.participants).toEqual([{ email: "a@b.com" }]);
  });

  it("accepts a single-meeting object (no array wrapper)", () => {
    const m = extractMeeting(
      { id: "solo", title: "Solo", participants: [{ email: "a@b.com" }] },
      "solo",
    );
    expect(m.title).toBe("Solo");
  });

  it("throws NOT_FOUND when the meeting id isn't in the response", () => {
    expect(() =>
      extractMeeting({ meetings: [{ id: "other" }] }, "missing"),
    ).toThrow(/not found/);
  });
});

describe("fetchGranolaTranscript", () => {
  it("issues get_meeting_transcript + get_meetings and builds a canonical payload", async () => {
    // Two responses: one for get_meeting_transcript, one for get_meetings.
    const fetchImpl = mockFetchSequence([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ content: "full transcript bytes" }),
            },
          ],
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                meetings: [
                  {
                    id: "uuid-1",
                    title: "Discovery — Acme",
                    start_time: "2026-05-13T15:00:00Z",
                    end_time: "2026-05-13T15:30:00Z",
                    summary: "Granola's own summary",
                    participants: [
                      { email: "alice@acme.com" },
                      {
                        email: "bob@acme.com",
                        linkedin_url: "linkedin.com/in/bob",
                      },
                    ],
                  },
                ],
              }),
            },
          ],
        },
      },
    ]);

    const client = new McpHttpClient({
      endpoint: "https://mcp.example.com/mcp",
      bearerToken: "T",
      fetchImpl,
    });

    const payload = await fetchGranolaTranscript("uuid-1", { client });
    expect(payload.source).toBe("granola");
    expect(payload.source_id).toBe("uuid-1");
    expect(payload.title).toBe("Discovery — Acme");
    expect(payload.summary).toBe("Granola's own summary");
    expect(payload.content).toBe("full transcript bytes");
    expect(payload.duration_seconds).toBe(1800); // derived from start/end
    expect(payload.participants).toEqual([
      { email: "alice@acme.com" },
      { email: "bob@acme.com", linkedin_url: "linkedin.com/in/bob" },
    ]);
  });

  it("rejects an empty meeting id", async () => {
    await expect(fetchGranolaTranscript("  ")).rejects.toThrow(
      /meeting id is required/,
    );
  });

  it("end-to-end: parses Granola's real XML shape for get_meetings", async () => {
    const xml = `<meetings_data from="May 6, 2026" to="May 6, 2026" count="1">
<meeting id="981dd0fc-1df2-4687-a05e-1b39e9aa7efa" title="sync" date="May 6, 2026 1:45 PM CST">
  <known_participants>
  Enrique Goudet (note creator) from Cluster <enrique@hello-cluster.com>, Luis Costa Laveron from Hello-cluster <luis@hello-cluster.com>
  </known_participants>

  <summary>
### Office Location & Setup

- Luis moved to new office.
  </summary>
</meeting>
</meetings_data>`;
    const fetchImpl = mockFetchSequence([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: "981dd0fc-1df2-4687-a05e-1b39e9aa7efa",
                title: "sync",
                transcript: "raw transcript bytes",
              }),
            },
          ],
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: xml }],
        },
      },
    ]);

    const client = new McpHttpClient({
      endpoint: "https://mcp.example.com/mcp",
      bearerToken: "T",
      fetchImpl,
    });

    const payload = await fetchGranolaTranscript(
      "981dd0fc-1df2-4687-a05e-1b39e9aa7efa",
      { client },
    );
    expect(payload.source).toBe("granola");
    expect(payload.source_id).toBe(
      "981dd0fc-1df2-4687-a05e-1b39e9aa7efa",
    );
    expect(payload.title).toBe("sync");
    expect(payload.content).toBe("raw transcript bytes");
    expect(payload.summary).toMatch(/Office Location/);
    expect(payload.started_at).toMatch(/^2026-05-/);
    expect(payload.participants).toEqual([
      { email: "enrique@hello-cluster.com" },
      { email: "luis@hello-cluster.com" },
    ]);
  });
});

describe("parseGranolaMeetingsXml", () => {
  it("parses attributes, participants, and summary from a single-meeting envelope", () => {
    const xml = `<meetings_data count="1">
<meeting id="abc-123" title="Sync with Luis" date="May 6, 2026 1:45 PM CST">
  <known_participants>
  Alice <alice@acme.com>, Bob <bob@acme.com>
  </known_participants>
  <summary>
- did stuff
  </summary>
</meeting>
</meetings_data>`;
    const m = parseGranolaMeetingsXml(xml, "abc-123");
    expect(m.id).toBe("abc-123");
    expect(m.title).toBe("Sync with Luis");
    expect(m.start).toMatch(/^2026-05-/);
    expect(m.summary).toMatch(/did stuff/);
    expect(m.participants).toEqual([
      { email: "alice@acme.com" },
      { email: "bob@acme.com" },
    ]);
  });

  it("matches the meeting id case-insensitively", () => {
    const xml = `<meetings_data><meeting id="ABC-XYZ" title="x" date="May 6, 2026 1:45 PM CST"><known_participants>a@b.com</known_participants></meeting></meetings_data>`;
    const m = parseGranolaMeetingsXml(xml, "abc-xyz");
    expect(m.id).toBe("ABC-XYZ");
  });

  it("walks past unrelated meetings to find the requested one", () => {
    const xml = `<meetings_data>
<meeting id="other" title="other" date="May 6, 2026 1:45 PM CST"><known_participants>x@y.com</known_participants></meeting>
<meeting id="wanted" title="wanted" date="May 6, 2026 1:45 PM CST"><known_participants>a@b.com</known_participants></meeting>
</meetings_data>`;
    const m = parseGranolaMeetingsXml(xml, "wanted");
    expect(m.title).toBe("wanted");
    expect(m.participants).toEqual([{ email: "a@b.com" }]);
  });

  it("throws NOT_FOUND when the id isn't in the XML", () => {
    const xml = `<meetings_data><meeting id="other" title="x" date="May 6, 2026 1:45 PM CST"><known_participants>a@b.com</known_participants></meeting></meetings_data>`;
    expect(() => parseGranolaMeetingsXml(xml, "missing")).toThrow(/not found/);
  });
});

describe("parseParticipantsText", () => {
  it("extracts every email and lowercases / dedupes", () => {
    const text =
      "Enrique Goudet (note creator) from Cluster <enrique@hello-cluster.com>, " +
      "Luis Costa Laveron from Hello-cluster <Luis@hello-cluster.com>, " +
      "duplicate <enrique@hello-cluster.com>";
    expect(parseParticipantsText(text)).toEqual([
      { email: "enrique@hello-cluster.com" },
      { email: "luis@hello-cluster.com" },
    ]);
  });

  it("returns empty list when no email is present", () => {
    expect(parseParticipantsText("just names, no emails")).toEqual([]);
  });
});
