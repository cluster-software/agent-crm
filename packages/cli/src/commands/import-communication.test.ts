import { describe, expect, it } from "vitest";
import { exec, importCommunicationBatch, Workspace } from "@agent-crm/sdk";
import { openTestWorkspace } from "../test/open-test-db.js";

describe("importCommunicationBatch", () => {
  it("imports Gmail communication data idempotently with relationships", async () => {
    const db = await openTestWorkspace();
    const ws = Workspace.fromDatabase(db);
    const batch = {
      people: [
        {
          sourceKey: "gmail:me@example.com:email:alice@example.com",
          email: "alice@example.com",
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
    const valuesAfterFirstImport = await countValues(db);
    const second = await importCommunicationBatch(ws, batch);

    expect(first.stats.people_created).toBe(2);
    expect(first.stats.companies_created).toBe(1);
    expect(first.stats.communication_threads_created).toBe(1);
    expect(first.stats.communication_messages_created).toBe(1);
    expect(second.stats.people_created).toBe(0);
    expect(second.stats.companies_created).toBe(0);
    expect(second.stats.communication_threads_created).toBe(0);
    expect(second.stats.communication_messages_created).toBe(0);
    await expect(countValues(db)).resolves.toBe(valuesAfterFirstImport);

    await expect(countRecords(db, "people")).resolves.toBe(2);
    await expect(countRecords(db, "companies")).resolves.toBe(1);
    await expect(countRecords(db, "communication_threads")).resolves.toBe(1);
    await expect(countRecords(db, "communication_messages")).resolves.toBe(1);
    await expect(hasAttribute(db, "people", "communication_threads")).resolves.toBe(true);
    await expect(hasAttribute(db, "people", "communication_messages")).resolves.toBe(true);
    await expect(countRefs(db, "people", "communication_threads")).resolves.toBe(2);
    await expect(countRefs(db, "people", "communication_messages")).resolves.toBe(2);
    await expect(countRefs(db, "people", "company")).resolves.toBe(2);
    await expect(countRefs(db, "companies", "team")).resolves.toBe(2);
    await expect(countRefs(db, "communication_threads", "messages")).resolves.toBe(1);

    await db.close();
  });

  it("imports LinkedIn communication people with linkedin_url and dedupes by it", async () => {
    const db = await openTestWorkspace();
    const ws = Workspace.fromDatabase(db);

    const first = await importCommunicationBatch(ws, linkedinMessageBatch({
      personSourceKey: "linkedin_unipile:acct-1:profile:https://www.linkedin.com/in/enrique-goudet",
      threadSourceKey: "linkedin_unipile:acct-1:thread:thread-1",
      messageSourceKey: "linkedin_unipile:acct-1:message:msg-1",
      messageId: "msg-1",
    }));
    const second = await importCommunicationBatch(ws, linkedinMessageBatch({
      personSourceKey: "linkedin_unipile:acct-1:profile:enrique-goudet",
      threadSourceKey: "linkedin_unipile:acct-1:thread:thread-2",
      messageSourceKey: "linkedin_unipile:acct-1:message:msg-2",
      messageId: "msg-2",
    }));

    expect(first.stats.people_created).toBe(1);
    expect(second.stats.people_created).toBe(0);
    await expect(countRecords(db, "people")).resolves.toBe(1);
    await expect(singleValue(db, "people", "linkedin_url")).resolves.toBe("linkedin.com/in/enrique-goudet");
    await expect(countValuesFor(db, "people", "linkedin_url")).resolves.toBe(1);
    await expect(countValuesFor(db, "people", "source_keys")).resolves.toBe(2);

    await db.close();
  });
});

function linkedinMessageBatch(input: {
  personSourceKey: string;
  threadSourceKey: string;
  messageSourceKey: string;
  messageId: string;
}) {
  return {
    people: [
      {
        sourceKey: input.personSourceKey,
        displayName: "Enrique Goudet",
        linkedinUrl: "https://www.linkedin.com/in/enrique-goudet/",
      },
    ],
    communicationThreads: [
      {
        sourceKey: input.threadSourceKey,
        provider: "linkedin_unipile",
        channel: "linkedin" as const,
        providerAccountId: "acct-1",
        providerThreadId: input.threadSourceKey,
        participantSourceKeys: [input.personSourceKey],
      },
    ],
    communicationMessages: [
      {
        sourceKey: input.messageSourceKey,
        provider: "linkedin_unipile",
        channel: "linkedin" as const,
        providerAccountId: "acct-1",
        providerMessageId: input.messageId,
        providerThreadId: input.threadSourceKey,
        threadSourceKey: input.threadSourceKey,
        bodyText: "yo",
        direction: "inbound" as const,
        participantSourceKeys: [input.personSourceKey],
      },
    ],
  };
}

async function countRecords(db: Awaited<ReturnType<typeof openTestWorkspace>>, objectSlug: string) {
  const result = await exec(
    db,
    "SELECT COUNT(*) AS n FROM acrm_record WHERE object_slug = $1",
    [objectSlug],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function countValues(db: Awaited<ReturnType<typeof openTestWorkspace>>) {
  const result = await exec(db, "SELECT COUNT(*) AS n FROM acrm_value", []);
  return Number(result.rows[0]?.n ?? 0);
}

async function countValuesFor(
  db: Awaited<ReturnType<typeof openTestWorkspace>>,
  objectSlug: string,
  attributeSlug: string,
) {
  const result = await exec(
    db,
    `SELECT COUNT(*) AS n
     FROM acrm_value
     WHERE object_slug = $1 AND attribute_slug = $2 AND active_until IS NULL`,
    [objectSlug, attributeSlug],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function singleValue(
  db: Awaited<ReturnType<typeof openTestWorkspace>>,
  objectSlug: string,
  attributeSlug: string,
) {
  const result = await exec(
    db,
    `SELECT value_json
     FROM acrm_value
     WHERE object_slug = $1 AND attribute_slug = $2 AND active_until IS NULL
     LIMIT 1`,
    [objectSlug, attributeSlug],
  );
  const value = result.rows[0]?.value_json;
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as { value?: unknown };
    return typeof parsed.value === "string" ? parsed.value : null;
  }
  if (value && typeof value === "object" && "value" in value) {
    const raw = (value as { value?: unknown }).value;
    return typeof raw === "string" ? raw : null;
  }
  return null;
}

async function hasAttribute(
  db: Awaited<ReturnType<typeof openTestWorkspace>>,
  objectSlug: string,
  attributeSlug: string,
) {
  const result = await exec(
    db,
    "SELECT 1 FROM acrm_attribute WHERE object_slug = $1 AND attribute_slug = $2",
    [objectSlug, attributeSlug],
  );
  return result.rows.length > 0;
}

async function countRefs(
  db: Awaited<ReturnType<typeof openTestWorkspace>>,
  objectSlug: string,
  attributeSlug: string,
) {
  const result = await exec(
    db,
    `SELECT COUNT(*) AS n FROM acrm_value
     WHERE object_slug = $1 AND attribute_slug = $2 AND active_until IS NULL`,
    [objectSlug, attributeSlug],
  );
  return Number(result.rows[0]?.n ?? 0);
}
