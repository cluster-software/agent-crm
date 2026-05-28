import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exec } from "../db/execute.js";
import { Workspace } from "../workspace.js";
import { importCommunicationBatch, type CommunicationImportBatch } from "./import-communication.js";

describe("importCommunicationBatch", () => {
  it("deduplicates duplicate fresh batch records by source key", async () => {
    await withWorkspace(async (workspace) => {
      const batch = duplicateCommunicationBatch();

      const result = await importCommunicationBatch(workspace, batch);
      await importCommunicationBatch(workspace, batch);

      expect(result.stats).toMatchObject({
        people_seen: 1,
        people_created: 1,
        companies_seen: 1,
        companies_created: 1,
        communication_threads_seen: 1,
        communication_threads_created: 1,
        communication_messages_seen: 1,
        communication_messages_created: 1,
      });
      await expect(recordCount(workspace, "people")).resolves.toBe(1);
      await expect(recordCount(workspace, "companies")).resolves.toBe(1);
      await expect(recordCount(workspace, "communication_threads")).resolves.toBe(1);
      await expect(recordCount(workspace, "communication_messages")).resolves.toBe(1);

      await expect(activeValueCount(workspace, "communication_messages", "provider")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_messages", "channel")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_messages", "subject")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_messages", "thread")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_threads", "provider")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_threads", "channel")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_threads", "subject")).resolves.toBe(1);
    });
  });

  it("keeps one active single value when different source keys resolve to one fresh record", async () => {
    await withWorkspace(async (workspace) => {
      await importCommunicationBatch(workspace, {
        people: [
          {
            sourceKey: "gmail:me@example.com:email:alice@example.com",
            email: "alice@example.com",
            displayName: "Alice A",
            profilePictureUrl: "https://media.example.com/alice-a.jpg",
          },
          {
            sourceKey: "gmail:other@example.com:email:alice@example.com",
            email: "alice@example.com",
            displayName: "Alice B",
            profilePictureUrl: "https://media.example.com/alice-b.jpg",
          },
        ],
        communicationThreads: [],
        communicationMessages: [],
      });

      await expect(recordCount(workspace, "people")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "people", "name")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "people", "profile_picture_url")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "people", "source_keys")).resolves.toBe(2);
      await expect(singleDisplayValue(workspace, "people", "name")).resolves.toBe("Alice B");
      await expect(singleDisplayValue(workspace, "people", "profile_picture_url")).resolves.toBe("https://media.example.com/alice-b.jpg");
    });
  });
});

async function withWorkspace(run: (workspace: Workspace) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "acrm-import-communication-"));
  try {
    const workspacePath = path.join(dir, "test.acrm");
    const workspace = await Workspace.create(workspacePath);
    try {
      await run(workspace);
    } finally {
      await workspace.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function duplicateCommunicationBatch(): CommunicationImportBatch {
  const person = {
    sourceKey: "gmail:me@example.com:email:alice@example.com",
    email: "alice@example.com",
    displayName: "Alice",
    companySourceKey: "gmail:me@example.com:company_domain:example.com",
  };
  const company = {
    sourceKey: "gmail:me@example.com:company_domain:example.com",
    domain: "example.com",
    name: "Example",
  };
  const thread = {
    sourceKey: "gmail:me@example.com:thread:thread-1",
    provider: "gmail",
    channel: "email" as const,
    providerAccountId: "me@example.com",
    providerThreadId: "thread-1",
    subject: "Hello",
    participantSourceKeys: [person.sourceKey],
  };
  const message = {
    sourceKey: "gmail:me@example.com:message:msg-1",
    provider: "gmail",
    channel: "email" as const,
    providerAccountId: "me@example.com",
    providerMessageId: "msg-1",
    providerThreadId: "thread-1",
    threadSourceKey: thread.sourceKey,
    subject: "Hello",
    senderSourceKey: person.sourceKey,
    participantSourceKeys: [person.sourceKey],
  };
  return {
    people: [person, { ...person }],
    companies: [company, { ...company }],
    communicationThreads: [thread, { ...thread }],
    communicationMessages: [message, { ...message }],
  };
}

async function recordCount(workspace: Workspace, objectSlug: string): Promise<number> {
  const result = await exec(
    workspace.lix,
    "SELECT COUNT(*) AS count FROM acrm_record WHERE object_slug = $1",
    [objectSlug],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function activeValueCount(
  workspace: Workspace,
  objectSlug: string,
  attributeSlug: string,
): Promise<number> {
  const result = await exec(
    workspace.lix,
    `SELECT COUNT(*) AS count
     FROM acrm_value
     WHERE active_until IS NULL
       AND object_slug = $1
       AND attribute_slug = $2`,
    [objectSlug, attributeSlug],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function singleDisplayValue(
  workspace: Workspace,
  objectSlug: string,
  attributeSlug: string,
): Promise<string | null> {
  const result = await exec(
    workspace.lix,
    `SELECT value_json
     FROM acrm_value
     WHERE active_until IS NULL
       AND object_slug = $1
       AND attribute_slug = $2
     LIMIT 1`,
    [objectSlug, attributeSlug],
  );
  const value = result.rows[0]?.value_json;
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && "full_name" in parsed) {
      const fullName = (parsed as { full_name?: unknown }).full_name;
      return typeof fullName === "string" ? fullName : null;
    }
    if (parsed && typeof parsed === "object" && "value" in parsed) {
      const display = (parsed as { value?: unknown }).value;
      return typeof display === "string" ? display : null;
    }
    return typeof parsed === "string" ? parsed : null;
  }
  return null;
}
