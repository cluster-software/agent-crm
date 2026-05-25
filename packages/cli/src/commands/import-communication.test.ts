import { describe, expect, it } from "vitest";
import { exec, importCommunicationBatch, Workspace } from "@agent-crm/sdk";
import { openTestWorkspace } from "../test/open-test-lix.js";

describe("importCommunicationBatch", () => {
  it("imports Gmail communication data idempotently with relationships", async () => {
    const lix = await openTestWorkspace();
    const ws = Workspace.fromLix(lix);
    const batch = {
      people: [
        {
          sourceKey: "gmail:me@example.com:email:alice@example.com",
          email: "alice@example.com",
          linkedinUrl: "https://www.linkedin.com/in/alice-lovelace/",
          displayName: "Alice",
          companySourceKey: "gmail:me@example.com:company_domain:example.com"
        },
        {
          sourceKey: "gmail:me@example.com:email:bob@example.com",
          email: "bob@example.com",
          displayName: "Bob",
          companySourceKey: "gmail:me@example.com:company_domain:example.com"
        }
      ],
      companies: [
        {
          sourceKey: "gmail:me@example.com:company_domain:example.com",
          domain: "example.com",
          name: "Example"
        }
      ],
      communicationThreads: [
        {
          sourceKey: "gmail:me@example.com:thread:thread-1",
          provider: "gmail",
          channel: "email" as const,
          providerAccountId: "acct-1",
          providerThreadId: "thread-1",
          subject: "Hello",
          messageCount: 1,
          participantSourceKeys: [
            "gmail:me@example.com:email:alice@example.com",
            "gmail:me@example.com:email:bob@example.com"
          ]
        }
      ],
      communicationMessages: [
        {
          sourceKey: "gmail:me@example.com:message:msg-1",
          provider: "gmail",
          channel: "email" as const,
          providerAccountId: "acct-1",
          providerMessageId: "msg-1",
          providerThreadId: "thread-1",
          threadSourceKey: "gmail:me@example.com:thread:thread-1",
          subject: "Hello",
          direction: "inbound" as const,
          senderSourceKey: "gmail:me@example.com:email:alice@example.com",
          recipientSourceKeys: ["gmail:me@example.com:email:bob@example.com"],
          participantSourceKeys: [
            "gmail:me@example.com:email:alice@example.com",
            "gmail:me@example.com:email:bob@example.com"
          ]
        }
      ]
    };

    const first = await importCommunicationBatch(ws, batch);
    const valuesAfterFirstImport = await countValues(lix);
    const second = await importCommunicationBatch(ws, batch);

    expect(first.stats.people_created).toBe(2);
    expect(first.stats.companies_created).toBe(1);
    expect(first.stats.communication_threads_created).toBe(1);
    expect(first.stats.communication_messages_created).toBe(1);
    expect(second.stats.people_created).toBe(0);
    expect(second.stats.companies_created).toBe(0);
    expect(second.stats.communication_threads_created).toBe(0);
    expect(second.stats.communication_messages_created).toBe(0);
    await expect(countValues(lix)).resolves.toBe(valuesAfterFirstImport);

    await expect(countRecords(lix, "people")).resolves.toBe(2);
    await expect(countRecords(lix, "companies")).resolves.toBe(1);
    await expect(countRecords(lix, "communication_threads")).resolves.toBe(1);
    await expect(countRecords(lix, "communication_messages")).resolves.toBe(1);
    await expect(hasAttribute(lix, "people", "communication_threads")).resolves.toBe(true);
    await expect(hasAttribute(lix, "people", "communication_messages")).resolves.toBe(true);
    await expect(countRefs(lix, "people", "communication_threads")).resolves.toBe(2);
    await expect(countRefs(lix, "people", "communication_messages")).resolves.toBe(2);
    await expect(countRefs(lix, "people", "company")).resolves.toBe(2);
    await expect(countRefs(lix, "companies", "team")).resolves.toBe(2);
    await expect(countRefs(lix, "communication_threads", "messages")).resolves.toBe(1);
    await expect(singleValueFor(lix, "people", "linkedin_url")).resolves.toBe("linkedin.com/in/alice-lovelace");

    await lix.close();
  });

  it("dedupes communication people by LinkedIn URL", async () => {
    const lix = await openTestWorkspace();
    const ws = Workspace.fromLix(lix);

    const first = await importCommunicationBatch(ws, {
      people: [
        {
          sourceKey: "linkedin_unipile:acct-1:profile:ACo123",
          linkedinUrl: "https://www.linkedin.com/in/ada-lovelace/",
          displayName: "Ada Lovelace"
        }
      ],
      communicationThreads: [],
      communicationMessages: []
    });
    const second = await importCommunicationBatch(ws, {
      people: [
        {
          sourceKey: "linkedin_unipile:acct-2:profile:ACo456",
          linkedinUrl: "linkedin.com/in/ada-lovelace",
          displayName: "Ada L."
        }
      ],
      communicationThreads: [],
      communicationMessages: []
    });

    expect(first.stats.people_created).toBe(1);
    expect(second.stats.people_created).toBe(0);
    await expect(countRecords(lix, "people")).resolves.toBe(1);
    await expect(singleValueFor(lix, "people", "linkedin_url")).resolves.toBe("linkedin.com/in/ada-lovelace");

    await lix.close();
  });
});

async function countRecords(lix: Awaited<ReturnType<typeof openTestWorkspace>>, objectSlug: string) {
  const result = await exec(
    lix,
    "SELECT COUNT(*) AS n FROM acrm_record WHERE object_slug = $1",
    [objectSlug],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function countValues(lix: Awaited<ReturnType<typeof openTestWorkspace>>) {
  const result = await exec(lix, "SELECT COUNT(*) AS n FROM acrm_value", []);
  return Number(result.rows[0]?.n ?? 0);
}

async function hasAttribute(
  lix: Awaited<ReturnType<typeof openTestWorkspace>>,
  objectSlug: string,
  attributeSlug: string,
) {
  const result = await exec(
    lix,
    "SELECT 1 FROM acrm_attribute WHERE object_slug = $1 AND attribute_slug = $2",
    [objectSlug, attributeSlug],
  );
  return result.rows.length > 0;
}

async function countRefs(
  lix: Awaited<ReturnType<typeof openTestWorkspace>>,
  objectSlug: string,
  attributeSlug: string,
) {
  const result = await exec(
    lix,
    `SELECT COUNT(*) AS n FROM acrm_value
     WHERE object_slug = $1 AND attribute_slug = $2 AND active_until IS NULL`,
    [objectSlug, attributeSlug],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function singleValueFor(
  lix: Awaited<ReturnType<typeof openTestWorkspace>>,
  objectSlug: string,
  attributeSlug: string,
) {
  const result = await exec(
    lix,
    `SELECT value_json FROM acrm_value
     WHERE object_slug = $1
       AND attribute_slug = $2
       AND active_until IS NULL
     LIMIT 1`,
    [objectSlug, attributeSlug],
  );
  const value = result.rows[0]?.value_json;
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as { value?: unknown };
    return typeof parsed.value === "string" ? parsed.value : null;
  }
  if (value && typeof value === "object" && "value" in value) {
    const item = value.value;
    return typeof item === "string" ? item : null;
  }
  return null;
}
