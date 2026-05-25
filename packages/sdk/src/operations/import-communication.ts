import { exec } from "../db/execute.js";
import {
  addMultiValue,
  findRecordByUnique,
  insertRecord,
  setSingleValue,
} from "../db/upsert.js";
import {
  encode,
  type AttributeType,
  type ValueJson,
} from "../domain/values.js";
import { generateUuid } from "../lib/ids.js";
import { loadAttributeConfig } from "../workspace/catalog.js";
import type { Workspace } from "../workspace.js";
import { seedAttributes, seedObjects } from "../workspace/seeds.js";

export type CommunicationImportPerson = {
  sourceKey: string;
  email?: string;
  displayName?: string;
};

export type CommunicationImportThread = {
  sourceKey: string;
  provider: string;
  channel: "email" | "linkedin";
  providerAccountId: string;
  providerThreadId: string;
  subject?: string;
  snippet?: string;
  firstMessageAt?: string;
  lastMessageAt?: string;
  messageCount?: number;
  participantSourceKeys?: string[];
};

export type CommunicationImportMessage = {
  sourceKey: string;
  provider: string;
  channel: "email" | "linkedin";
  providerAccountId: string;
  providerMessageId: string;
  providerThreadId?: string;
  threadSourceKey?: string;
  subject?: string;
  snippet?: string;
  bodyText?: string;
  sentAt?: string;
  direction?: "inbound" | "outbound";
  labelIds?: string[];
  senderSourceKey?: string;
  recipientSourceKeys?: string[];
  participantSourceKeys?: string[];
};

export type CommunicationImportBatch = {
  people: CommunicationImportPerson[];
  communicationThreads: CommunicationImportThread[];
  communicationMessages: CommunicationImportMessage[];
};

export type CommunicationImportResult = {
  stats: {
    people_seen: number;
    people_created: number;
    communication_threads_seen: number;
    communication_threads_created: number;
    communication_messages_seen: number;
    communication_messages_created: number;
  };
};

const SOURCE = "sync-engine";

export async function importCommunicationBatch(
  workspace: Workspace,
  batch: CommunicationImportBatch,
): Promise<CommunicationImportResult> {
  await ensureCommunicationSchema(workspace);
  const lix = workspace.lix;
  const stats: CommunicationImportResult["stats"] = {
    people_seen: batch.people.length,
    people_created: 0,
    communication_threads_seen: batch.communicationThreads.length,
    communication_threads_created: 0,
    communication_messages_seen: batch.communicationMessages.length,
    communication_messages_created: 0,
  };

  const personIds = new Map<string, string>();
  const threadIds = new Map<string, string>();
  const messageIds = new Map<string, string>();

  for (const person of batch.people) {
    const { recordId, created } = await upsertPerson(workspace, person);
    personIds.set(person.sourceKey, recordId);
    if (created) stats.people_created++;
  }

  for (const thread of batch.communicationThreads) {
    const { recordId, created } = await upsertThread(workspace, thread);
    threadIds.set(thread.sourceKey, recordId);
    if (created) stats.communication_threads_created++;
  }

  for (const message of batch.communicationMessages) {
    const { recordId, created } = await upsertMessage(workspace, message);
    messageIds.set(message.sourceKey, recordId);
    if (created) stats.communication_messages_created++;
  }

  for (const thread of batch.communicationThreads) {
    const threadId = threadIds.get(thread.sourceKey);
    if (!threadId) continue;
    for (const personSourceKey of thread.participantSourceKeys ?? []) {
      const personId = personIds.get(personSourceKey) ?? await findBySourceKey(lix, "people", personSourceKey);
      if (!personId) continue;
      await addReference(lix, "people", personId, "communication_threads", "communication_threads", threadId);
      await addReference(lix, "communication_threads", threadId, "participants", "people", personId);
    }
  }

  for (const message of batch.communicationMessages) {
    const messageId = messageIds.get(message.sourceKey);
    if (!messageId) continue;

    const threadSourceKey = message.threadSourceKey ??
      batch.communicationThreads.find((thread) => thread.providerThreadId === message.providerThreadId)?.sourceKey;
    const threadId = threadSourceKey
      ? threadIds.get(threadSourceKey) ?? await findBySourceKey(lix, "communication_threads", threadSourceKey)
      : null;
    if (threadId) {
      await setSingleValueIfChanged(lix, referenceValue("communication_messages", messageId, "thread", "communication_threads", threadId));
      await addReference(lix, "communication_threads", threadId, "messages", "communication_messages", messageId);
    }

    if (message.senderSourceKey) {
      const senderId = personIds.get(message.senderSourceKey) ?? await findBySourceKey(lix, "people", message.senderSourceKey);
      if (senderId) await setSingleValueIfChanged(lix, referenceValue("communication_messages", messageId, "sender", "people", senderId));
    }

    for (const personSourceKey of message.recipientSourceKeys ?? []) {
      const personId = personIds.get(personSourceKey) ?? await findBySourceKey(lix, "people", personSourceKey);
      if (personId) await addReference(lix, "communication_messages", messageId, "recipients", "people", personId);
    }

    for (const personSourceKey of message.participantSourceKeys ?? []) {
      const personId = personIds.get(personSourceKey) ?? await findBySourceKey(lix, "people", personSourceKey);
      if (!personId) continue;
      await addReference(lix, "people", personId, "communication_messages", "communication_messages", messageId);
      await addReference(lix, "communication_messages", messageId, "participants", "people", personId);
    }
  }

  return { stats };
}

async function ensureCommunicationSchema(workspace: Workspace): Promise<void> {
  await seedObjects(workspace.lix);
  await seedAttributes(workspace.lix);
}

async function upsertPerson(
  workspace: Workspace,
  person: CommunicationImportPerson,
): Promise<{ recordId: string; created: boolean }> {
  const lix = workspace.lix;
  let recordId = await findBySourceKey(lix, "people", person.sourceKey);
  if (!recordId && person.email) {
    recordId = await findRecordByUnique(lix, "people", "email_addresses", person.email.trim().toLowerCase());
  }
  const created = !recordId;
  if (!recordId) {
    recordId = await generateUuid(lix);
    await insertRecord(lix, "people", recordId);
  }

  await addTextKey(lix, "people", recordId, "source_keys", person.sourceKey);
  if (person.email) {
    await addMultiValue(lix, value("people", recordId, "email_addresses", "email-address", person.email));
  }
  if (person.displayName) {
    await setSingleValueIfChanged(lix, value("people", recordId, "name", "personal-name", person.displayName));
  }

  return { recordId, created };
}

async function upsertThread(
  workspace: Workspace,
  thread: CommunicationImportThread,
): Promise<{ recordId: string; created: boolean }> {
  const lix = workspace.lix;
  let recordId = await findBySourceKey(lix, "communication_threads", thread.sourceKey);
  const created = !recordId;
  if (!recordId) {
    recordId = await generateUuid(lix);
    await insertRecord(lix, "communication_threads", recordId);
  }

  await addTextKey(lix, "communication_threads", recordId, "source_keys", thread.sourceKey);
  await setSingleValueIfChanged(lix, value("communication_threads", recordId, "channel", "status", thread.channel));
  await setSingleValueIfChanged(lix, value("communication_threads", recordId, "provider", "text", thread.provider));
  await setSingleValueIfChanged(lix, value("communication_threads", recordId, "provider_account_id", "text", thread.providerAccountId));
  await setSingleValueIfChanged(lix, value("communication_threads", recordId, "provider_thread_id", "text", thread.providerThreadId));
  if (thread.subject) await setSingleValueIfChanged(lix, value("communication_threads", recordId, "subject", "text", thread.subject));
  if (thread.snippet) await setSingleValueIfChanged(lix, value("communication_threads", recordId, "snippet", "text", thread.snippet));
  if (thread.firstMessageAt) await setSingleValueIfChanged(lix, value("communication_threads", recordId, "first_message_at", "timestamp", thread.firstMessageAt));
  if (thread.lastMessageAt) await setSingleValueIfChanged(lix, value("communication_threads", recordId, "last_message_at", "timestamp", thread.lastMessageAt));
  if (thread.messageCount != null) await setSingleValueIfChanged(lix, value("communication_threads", recordId, "message_count", "number", thread.messageCount));

  return { recordId, created };
}

async function upsertMessage(
  workspace: Workspace,
  message: CommunicationImportMessage,
): Promise<{ recordId: string; created: boolean }> {
  const lix = workspace.lix;
  let recordId = await findBySourceKey(lix, "communication_messages", message.sourceKey);
  const created = !recordId;
  if (!recordId) {
    recordId = await generateUuid(lix);
    await insertRecord(lix, "communication_messages", recordId);
  }

  await addTextKey(lix, "communication_messages", recordId, "source_keys", message.sourceKey);
  await setSingleValueIfChanged(lix, value("communication_messages", recordId, "channel", "status", message.channel));
  await setSingleValueIfChanged(lix, value("communication_messages", recordId, "provider", "text", message.provider));
  await setSingleValueIfChanged(lix, value("communication_messages", recordId, "provider_account_id", "text", message.providerAccountId));
  await setSingleValueIfChanged(lix, value("communication_messages", recordId, "provider_message_id", "text", message.providerMessageId));
  if (message.providerThreadId) await setSingleValueIfChanged(lix, value("communication_messages", recordId, "provider_thread_id", "text", message.providerThreadId));
  if (message.sentAt) await setSingleValueIfChanged(lix, value("communication_messages", recordId, "sent_at", "timestamp", message.sentAt));
  if (message.subject) await setSingleValueIfChanged(lix, value("communication_messages", recordId, "subject", "text", message.subject));
  if (message.snippet) await setSingleValueIfChanged(lix, value("communication_messages", recordId, "snippet", "text", message.snippet));
  if (message.bodyText) await setSingleValueIfChanged(lix, value("communication_messages", recordId, "body_text", "text", message.bodyText));
  if (message.direction) await setSingleValueIfChanged(lix, value("communication_messages", recordId, "direction", "status", message.direction));
  for (const labelId of message.labelIds ?? []) {
    await addTextKey(lix, "communication_messages", recordId, "label_ids", labelId);
  }

  return { recordId, created };
}

async function findBySourceKey(
  lix: Workspace["lix"],
  objectSlug: string,
  sourceKey: string,
): Promise<string | null> {
  return findRecordByUnique(lix, objectSlug, "source_keys", sourceKey);
}

async function addTextKey(
  lix: Workspace["lix"],
  objectSlug: string,
  recordId: string,
  attributeSlug: string,
  sourceKey: string,
): Promise<void> {
  await addMultiValue(lix, value(objectSlug, recordId, attributeSlug, "text", sourceKey));
}

async function addReference(
  lix: Workspace["lix"],
  objectSlug: string,
  recordId: string,
  attributeSlug: string,
  targetObject: string,
  targetRecordId: string,
): Promise<void> {
  const existing = await exec(
    lix,
    `SELECT 1 FROM acrm_value
     WHERE object_slug = $1 AND record_id = $2 AND attribute_slug = $3
       AND ref_object = $4 AND ref_record_id = $5 AND active_until IS NULL
     LIMIT 1`,
    [objectSlug, recordId, attributeSlug, targetObject, targetRecordId],
  );
  if (existing.rows.length) return;
  await addMultiValue(lix, referenceValue(objectSlug, recordId, attributeSlug, targetObject, targetRecordId));
}

async function setSingleValueIfChanged(
  lix: Workspace["lix"],
  args: ReturnType<typeof value>,
): Promise<void> {
  const config = args.attribute_type === "status" || args.attribute_type === "select"
    ? await loadAttributeConfig(lix, args.object_slug, args.attribute_slug)
    : undefined;
  const nextValue = encode(args.attribute_type, args.value, config);
  const existing = await exec(
    lix,
    `SELECT value_json FROM acrm_value
     WHERE object_slug = $1 AND record_id = $2 AND attribute_slug = $3
       AND active_until IS NULL
     LIMIT 1`,
    [args.object_slug, args.record_id, args.attribute_slug],
  );
  const currentValue = parseValueJson(existing.rows[0]?.value_json);
  if (currentValue && sameValueJson(currentValue, nextValue)) return;
  await setSingleValue(lix, args);
}

function value(
  object_slug: string,
  record_id: string,
  attribute_slug: string,
  attribute_type: AttributeType,
  value: unknown,
) {
  return {
    object_slug,
    record_id,
    attribute_slug,
    attribute_type,
    value,
    source: SOURCE,
    provenance: {},
  };
}

function referenceValue(
  object_slug: string,
  record_id: string,
  attribute_slug: string,
  target_object: string,
  target_record_id: string,
) {
  return value(object_slug, record_id, attribute_slug, "record-reference", {
    target_object,
    target_record_id,
  });
}

function parseValueJson(value: unknown): ValueJson | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isObject(value) ? value : null;
}

function sameValueJson(left: ValueJson, right: ValueJson): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isObject(value: unknown): value is ValueJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
