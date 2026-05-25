import type { LixRuntimeValue } from "@lix-js/sdk";
import { exec } from "../db/execute.js";
import {
  prepareValueInsert,
  type PreparedValueInsert,
} from "../db/value-row.js";
import {
  encode,
  type AttributeConfig,
  type AttributeType,
  type ValueJson,
} from "../domain/values.js";
import { uuidv7 } from "../lib/uuidv7.js";
import { nowIso } from "../lib/time.js";
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

type RecordPlan = {
  objectSlug: "people" | "communication_threads" | "communication_messages";
  recordId: string;
  created: boolean;
};

type ExistingValues = {
  singleValues: Map<string, ValueJson>;
  multiValues: Set<string>;
};

type ValueInput = {
  object_slug: string;
  record_id: string;
  attribute_slug: string;
  attribute_type: AttributeType;
  value: unknown;
  source: string;
  provenance: Record<string, unknown>;
};

const SOURCE = "sync-engine";
const MAX_BATCH_ROWS = 5000;
const SELECT_CHUNK_SIZE = 500;

const CHANNEL_CONFIG: AttributeConfig = {
  options: [
    { id: "email", title: "Email" },
    { id: "linkedin", title: "LinkedIn" },
  ],
};

const DIRECTION_CONFIG: AttributeConfig = {
  options: [
    { id: "inbound", title: "Inbound" },
    { id: "outbound", title: "Outbound" },
  ],
};

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

  const sourceKeys = collectSourceKeys(batch);
  const sourceIndex = await loadSourceKeyIndex(lix, sourceKeys);
  const plannedSourceIndex = new Map(sourceIndex);
  const emailIndex = await loadPeopleByEmail(lix, batch.people);
  const plannedEmailIndex = new Map(emailIndex);

  const personPlans = new Map<string, RecordPlan>();
  const threadPlans = new Map<string, RecordPlan>();
  const messagePlans = new Map<string, RecordPlan>();
  const recordsToCreate: RecordPlan[] = [];

  for (const person of batch.people) {
    if (personPlans.has(person.sourceKey)) continue;
    const email = normalizeEmail(person.email);
    const existingRecordId = plannedSourceIndex.get(sourceIndexKey("people", person.sourceKey)) ??
      (email ? plannedEmailIndex.get(email) : undefined);
    const plan = planRecord("people", person.sourceKey, existingRecordId, recordsToCreate, plannedSourceIndex);
    personPlans.set(person.sourceKey, plan);
    if (email) plannedEmailIndex.set(email, plan.recordId);
    if (plan.created) stats.people_created++;
  }

  for (const thread of batch.communicationThreads) {
    if (threadPlans.has(thread.sourceKey)) continue;
    const existingRecordId = plannedSourceIndex.get(sourceIndexKey("communication_threads", thread.sourceKey));
    const plan = planRecord("communication_threads", thread.sourceKey, existingRecordId, recordsToCreate, plannedSourceIndex);
    threadPlans.set(thread.sourceKey, plan);
    if (plan.created) stats.communication_threads_created++;
  }

  for (const message of batch.communicationMessages) {
    if (messagePlans.has(message.sourceKey)) continue;
    const existingRecordId = plannedSourceIndex.get(sourceIndexKey("communication_messages", message.sourceKey));
    const plan = planRecord("communication_messages", message.sourceKey, existingRecordId, recordsToCreate, plannedSourceIndex);
    messagePlans.set(message.sourceKey, plan);
    if (plan.created) stats.communication_messages_created++;
  }

  const threadSourceByProviderId = new Map(
    batch.communicationThreads.map((thread) => [thread.providerThreadId, thread.sourceKey]),
  );
  const touchedRecords = collectTouchedRecords(batch, personPlans, threadPlans, messagePlans, plannedSourceIndex, threadSourceByProviderId);
  const existingValues = await loadExistingValues(lix, touchedRecords);
  const writer = new CommunicationWriteBatcher(lix);

  for (const record of recordsToCreate) {
    writer.enqueueRecord({
      object_slug: record.objectSlug,
      record_id: record.recordId,
    });
  }

  for (const person of batch.people) {
    const plan = personPlans.get(person.sourceKey);
    if (!plan) continue;
    enqueueMulti(writer, existingValues, plan, "source_keys", "text", person.sourceKey);
    if (person.email) {
      enqueueMulti(writer, existingValues, plan, "email_addresses", "email-address", person.email);
    }
    if (person.displayName) {
      enqueueSingle(writer, existingValues, plan, "name", "personal-name", person.displayName);
    }
  }

  for (const thread of batch.communicationThreads) {
    const plan = threadPlans.get(thread.sourceKey);
    if (!plan) continue;
    enqueueMulti(writer, existingValues, plan, "source_keys", "text", thread.sourceKey);
    enqueueSingle(writer, existingValues, plan, "channel", "status", thread.channel);
    enqueueSingle(writer, existingValues, plan, "provider", "text", thread.provider);
    enqueueSingle(writer, existingValues, plan, "provider_account_id", "text", thread.providerAccountId);
    enqueueSingle(writer, existingValues, plan, "provider_thread_id", "text", thread.providerThreadId);
    if (thread.subject) enqueueSingle(writer, existingValues, plan, "subject", "text", thread.subject);
    if (thread.snippet) enqueueSingle(writer, existingValues, plan, "snippet", "text", thread.snippet);
    if (thread.firstMessageAt) enqueueSingle(writer, existingValues, plan, "first_message_at", "timestamp", thread.firstMessageAt);
    if (thread.lastMessageAt) enqueueSingle(writer, existingValues, plan, "last_message_at", "timestamp", thread.lastMessageAt);
    if (thread.messageCount != null) enqueueSingle(writer, existingValues, plan, "message_count", "number", thread.messageCount);
  }

  for (const message of batch.communicationMessages) {
    const plan = messagePlans.get(message.sourceKey);
    if (!plan) continue;
    enqueueMulti(writer, existingValues, plan, "source_keys", "text", message.sourceKey);
    enqueueSingle(writer, existingValues, plan, "channel", "status", message.channel);
    enqueueSingle(writer, existingValues, plan, "provider", "text", message.provider);
    enqueueSingle(writer, existingValues, plan, "provider_account_id", "text", message.providerAccountId);
    enqueueSingle(writer, existingValues, plan, "provider_message_id", "text", message.providerMessageId);
    if (message.providerThreadId) enqueueSingle(writer, existingValues, plan, "provider_thread_id", "text", message.providerThreadId);
    if (message.sentAt) enqueueSingle(writer, existingValues, plan, "sent_at", "timestamp", message.sentAt);
    if (message.subject) enqueueSingle(writer, existingValues, plan, "subject", "text", message.subject);
    if (message.snippet) enqueueSingle(writer, existingValues, plan, "snippet", "text", message.snippet);
    if (message.bodyText) enqueueSingle(writer, existingValues, plan, "body_text", "text", message.bodyText);
    if (message.direction) enqueueSingle(writer, existingValues, plan, "direction", "status", message.direction);
    for (const labelId of message.labelIds ?? []) {
      enqueueMulti(writer, existingValues, plan, "label_ids", "text", labelId);
    }
  }

  for (const thread of batch.communicationThreads) {
    const threadPlan = threadPlans.get(thread.sourceKey);
    if (!threadPlan) continue;
    for (const personSourceKey of thread.participantSourceKeys ?? []) {
      const personId = resolveRecordId("people", personSourceKey, personPlans, plannedSourceIndex);
      if (!personId) continue;
      enqueueReference(writer, existingValues, {
        objectSlug: "people",
        recordId: personId,
        created: isCreatedRecord(recordsToCreate, "people", personId),
      }, "communication_threads", "communication_threads", threadPlan.recordId);
      enqueueReference(writer, existingValues, threadPlan, "participants", "people", personId);
    }
  }

  for (const message of batch.communicationMessages) {
    const messagePlan = messagePlans.get(message.sourceKey);
    if (!messagePlan) continue;

    const threadSourceKey = message.threadSourceKey ??
      (message.providerThreadId ? threadSourceByProviderId.get(message.providerThreadId) : undefined);
    const threadId = threadSourceKey
      ? resolveRecordId("communication_threads", threadSourceKey, threadPlans, plannedSourceIndex)
      : undefined;
    if (threadId) {
      enqueueSingleReference(writer, existingValues, messagePlan, "thread", "communication_threads", threadId);
      enqueueReference(writer, existingValues, {
        objectSlug: "communication_threads",
        recordId: threadId,
        created: isCreatedRecord(recordsToCreate, "communication_threads", threadId),
      }, "messages", "communication_messages", messagePlan.recordId);
    }

    if (message.senderSourceKey) {
      const senderId = resolveRecordId("people", message.senderSourceKey, personPlans, plannedSourceIndex);
      if (senderId) enqueueSingleReference(writer, existingValues, messagePlan, "sender", "people", senderId);
    }

    for (const personSourceKey of message.recipientSourceKeys ?? []) {
      const personId = resolveRecordId("people", personSourceKey, personPlans, plannedSourceIndex);
      if (personId) enqueueReference(writer, existingValues, messagePlan, "recipients", "people", personId);
    }

    for (const personSourceKey of message.participantSourceKeys ?? []) {
      const personId = resolveRecordId("people", personSourceKey, personPlans, plannedSourceIndex);
      if (!personId) continue;
      enqueueReference(writer, existingValues, {
        objectSlug: "people",
        recordId: personId,
        created: isCreatedRecord(recordsToCreate, "people", personId),
      }, "communication_messages", "communication_messages", messagePlan.recordId);
      enqueueReference(writer, existingValues, messagePlan, "participants", "people", personId);
    }
  }

  await writer.flush();
  return { stats };
}

async function ensureCommunicationSchema(workspace: Workspace): Promise<void> {
  const haveCommunicationSchema = await exec(
    workspace.lix,
    `SELECT 1
     FROM acrm_attribute
     WHERE object_slug = 'communication_messages'
       AND attribute_slug = 'participants'
     LIMIT 1`,
  );
  if (haveCommunicationSchema.rows.length > 0) return;

  await seedObjects(workspace.lix);
  await seedAttributes(workspace.lix);
}

function planRecord(
  objectSlug: RecordPlan["objectSlug"],
  sourceKey: string,
  existingRecordId: string | undefined,
  recordsToCreate: RecordPlan[],
  plannedSourceIndex: Map<string, string>,
): RecordPlan {
  const recordId = existingRecordId ?? uuidv7();
  const plan = {
    objectSlug,
    recordId,
    created: existingRecordId == null,
  };
  if (plan.created) recordsToCreate.push(plan);
  plannedSourceIndex.set(sourceIndexKey(objectSlug, sourceKey), recordId);
  return plan;
}

function collectSourceKeys(batch: CommunicationImportBatch): string[] {
  const keys = new Set<string>();
  for (const person of batch.people) keys.add(person.sourceKey);
  for (const thread of batch.communicationThreads) {
    keys.add(thread.sourceKey);
    for (const participant of thread.participantSourceKeys ?? []) keys.add(participant);
  }
  for (const message of batch.communicationMessages) {
    keys.add(message.sourceKey);
    if (message.threadSourceKey) keys.add(message.threadSourceKey);
    if (message.senderSourceKey) keys.add(message.senderSourceKey);
    for (const recipient of message.recipientSourceKeys ?? []) keys.add(recipient);
    for (const participant of message.participantSourceKeys ?? []) keys.add(participant);
  }
  return [...keys];
}

async function loadSourceKeyIndex(
  lix: Workspace["lix"],
  sourceKeys: string[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const chunk of chunks(unique(sourceKeys), SELECT_CHUNK_SIZE)) {
    const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
    const result = await exec(
      lix,
      `SELECT object_slug, record_id, normalized_key
       FROM acrm_value
       WHERE active_until IS NULL
         AND attribute_slug = 'source_keys'
         AND normalized_key IN (${placeholders})`,
      chunk,
    );
    for (const row of result.rows) {
      if (typeof row.object_slug !== "string" || typeof row.record_id !== "string" || typeof row.normalized_key !== "string") {
        continue;
      }
      index.set(sourceIndexKey(row.object_slug, row.normalized_key), row.record_id);
    }
  }
  return index;
}

async function loadPeopleByEmail(
  lix: Workspace["lix"],
  people: CommunicationImportPerson[],
): Promise<Map<string, string>> {
  const emails = unique(people.map((person) => normalizeEmail(person.email)).filter((email): email is string => Boolean(email)));
  const index = new Map<string, string>();
  for (const chunk of chunks(emails, SELECT_CHUNK_SIZE)) {
    const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
    const result = await exec(
      lix,
      `SELECT record_id, normalized_key
       FROM acrm_value
       WHERE active_until IS NULL
         AND object_slug = 'people'
         AND attribute_slug = 'email_addresses'
         AND normalized_key IN (${placeholders})`,
      chunk,
    );
    for (const row of result.rows) {
      if (typeof row.record_id === "string" && typeof row.normalized_key === "string") {
        index.set(row.normalized_key, row.record_id);
      }
    }
  }
  return index;
}

function collectTouchedRecords(
  batch: CommunicationImportBatch,
  personPlans: Map<string, RecordPlan>,
  threadPlans: Map<string, RecordPlan>,
  messagePlans: Map<string, RecordPlan>,
  plannedSourceIndex: Map<string, string>,
  threadSourceByProviderId: Map<string, string>,
): Map<string, Set<string>> {
  const touched = new Map<string, Set<string>>();
  const add = (objectSlug: string, recordId: string | undefined) => {
    if (!recordId) return;
    const set = touched.get(objectSlug) ?? new Set<string>();
    set.add(recordId);
    touched.set(objectSlug, set);
  };

  for (const plan of personPlans.values()) add(plan.objectSlug, plan.recordId);
  for (const plan of threadPlans.values()) add(plan.objectSlug, plan.recordId);
  for (const plan of messagePlans.values()) add(plan.objectSlug, plan.recordId);

  for (const thread of batch.communicationThreads) {
    for (const personSourceKey of thread.participantSourceKeys ?? []) {
      add("people", resolveRecordId("people", personSourceKey, personPlans, plannedSourceIndex));
    }
  }
  for (const message of batch.communicationMessages) {
    const threadSourceKey = message.threadSourceKey ??
      (message.providerThreadId ? threadSourceByProviderId.get(message.providerThreadId) : undefined);
    add("communication_threads", threadSourceKey
      ? resolveRecordId("communication_threads", threadSourceKey, threadPlans, plannedSourceIndex)
      : undefined);
    if (message.senderSourceKey) {
      add("people", resolveRecordId("people", message.senderSourceKey, personPlans, plannedSourceIndex));
    }
    for (const personSourceKey of message.recipientSourceKeys ?? []) {
      add("people", resolveRecordId("people", personSourceKey, personPlans, plannedSourceIndex));
    }
    for (const personSourceKey of message.participantSourceKeys ?? []) {
      add("people", resolveRecordId("people", personSourceKey, personPlans, plannedSourceIndex));
    }
  }
  return touched;
}

async function loadExistingValues(
  lix: Workspace["lix"],
  touchedRecords: Map<string, Set<string>>,
): Promise<ExistingValues> {
  const existing: ExistingValues = {
    singleValues: new Map(),
    multiValues: new Set(),
  };

  for (const [objectSlug, recordIds] of touchedRecords) {
    for (const chunk of chunks([...recordIds], SELECT_CHUNK_SIZE)) {
      const placeholders = chunk.map((_, index) => `$${index + 2}`).join(", ");
      const result = await exec(
        lix,
        `SELECT object_slug, record_id, attribute_slug, value_json,
                normalized_key, ref_object, ref_record_id
         FROM acrm_value
         WHERE active_until IS NULL
           AND object_slug = $1
           AND record_id IN (${placeholders})`,
        [objectSlug, ...chunk],
      );

      for (const row of result.rows) {
        if (typeof row.object_slug !== "string" || typeof row.record_id !== "string" || typeof row.attribute_slug !== "string") {
          continue;
        }
        const valueJson = parseValueJson(row.value_json);
        if (valueJson) {
          existing.singleValues.set(singleValueKey(row.object_slug, row.record_id, row.attribute_slug), valueJson);
        }
        if (typeof row.normalized_key === "string") {
          existing.multiValues.add(normalizedValueKey(row.object_slug, row.record_id, row.attribute_slug, row.normalized_key));
        }
        if (typeof row.ref_object === "string" && typeof row.ref_record_id === "string") {
          existing.multiValues.add(referenceValueKey(row.object_slug, row.record_id, row.attribute_slug, row.ref_object, row.ref_record_id));
        }
      }
    }
  }

  return existing;
}

function enqueueSingle(
  writer: CommunicationWriteBatcher,
  existing: ExistingValues,
  plan: RecordPlan,
  attributeSlug: string,
  attributeType: AttributeType,
  rawValue: unknown,
): void {
  const valueJson = encode(attributeType, rawValue, attributeConfig(plan.objectSlug, attributeSlug));
  const key = singleValueKey(plan.objectSlug, plan.recordId, attributeSlug);
  const current = existing.singleValues.get(key);
  if (!plan.created && current && sameValueJson(current, valueJson)) return;
  if (!plan.created && current) {
    writer.retireSingle(plan.objectSlug, plan.recordId, attributeSlug);
  }
  existing.singleValues.set(key, valueJson);
  writer.enqueueValue(valueInput(plan.objectSlug, plan.recordId, attributeSlug, attributeType, valueJson));
}

function enqueueSingleReference(
  writer: CommunicationWriteBatcher,
  existing: ExistingValues,
  plan: RecordPlan,
  attributeSlug: string,
  targetObject: string,
  targetRecordId: string,
): void {
  enqueueSingle(writer, existing, plan, attributeSlug, "record-reference", {
    target_object: targetObject,
    target_record_id: targetRecordId,
  });
}

function enqueueMulti(
  writer: CommunicationWriteBatcher,
  existing: ExistingValues,
  plan: RecordPlan,
  attributeSlug: string,
  attributeType: AttributeType,
  rawValue: unknown,
): void {
  const valueJson = encode(attributeType, rawValue, attributeConfig(plan.objectSlug, attributeSlug));
  writer.enqueueValueIfMissing(existing, plan.created, valueInput(plan.objectSlug, plan.recordId, attributeSlug, attributeType, valueJson));
}

function enqueueReference(
  writer: CommunicationWriteBatcher,
  existing: ExistingValues,
  plan: RecordPlan,
  attributeSlug: string,
  targetObject: string,
  targetRecordId: string,
): void {
  writer.enqueueValueIfMissing(existing, plan.created, valueInput(plan.objectSlug, plan.recordId, attributeSlug, "record-reference", {
    target_object: targetObject,
    target_record_id: targetRecordId,
  }));
}

function valueInput(
  objectSlug: string,
  recordId: string,
  attributeSlug: string,
  attributeType: AttributeType,
  valueJson: ValueJson,
): ValueInput {
  return {
    object_slug: objectSlug,
    record_id: recordId,
    attribute_slug: attributeSlug,
    attribute_type: attributeType,
    value: valueJson,
    source: SOURCE,
    provenance: {},
  };
}

function attributeConfig(objectSlug: string, attributeSlug: string): AttributeConfig | undefined {
  if (
    (objectSlug === "communication_threads" || objectSlug === "communication_messages") &&
    attributeSlug === "channel"
  ) {
    return CHANNEL_CONFIG;
  }
  if (objectSlug === "communication_messages" && attributeSlug === "direction") {
    return DIRECTION_CONFIG;
  }
  return undefined;
}

function resolveRecordId(
  objectSlug: RecordPlan["objectSlug"],
  sourceKey: string,
  planned: Map<string, RecordPlan>,
  plannedSourceIndex: Map<string, string>,
): string | undefined {
  return planned.get(sourceKey)?.recordId ?? plannedSourceIndex.get(sourceIndexKey(objectSlug, sourceKey));
}

function isCreatedRecord(
  recordsToCreate: RecordPlan[],
  objectSlug: RecordPlan["objectSlug"],
  recordId: string,
): boolean {
  return recordsToCreate.some((record) => record.objectSlug === objectSlug && record.recordId === recordId);
}

class CommunicationWriteBatcher {
  private records: Array<{ object_slug: string; record_id: string }> = [];
  private values: PreparedValueInsert[] = [];
  private pendingValueKeys = new Set<string>();
  private singlesToRetire: Array<{ object_slug: string; record_id: string; attribute_slug: string }> = [];
  private pendingRetireKeys = new Set<string>();

  constructor(private readonly lix: Workspace["lix"]) {}

  enqueueRecord(record: { object_slug: string; record_id: string }): void {
    this.records.push(record);
  }

  enqueueValue(input: ValueInput): void {
    this.values.push(prepareValueInsert(uuidv7(), {
      object_slug: input.object_slug,
      record_id: input.record_id,
      attribute_slug: input.attribute_slug,
      attribute_type: input.attribute_type,
      value_json: input.value as ValueJson,
      source: input.source,
      provenance: input.provenance,
    }));
  }

  enqueueValueIfMissing(existing: ExistingValues, isFreshRecord: boolean, input: ValueInput): void {
    const prepared = prepareValueInsert(uuidv7(), {
      object_slug: input.object_slug,
      record_id: input.record_id,
      attribute_slug: input.attribute_slug,
      attribute_type: input.attribute_type,
      value_json: input.value as ValueJson,
      source: input.source,
      provenance: input.provenance,
    });
    const key = preparedValueKey(prepared);
    if (key) {
      if (this.pendingValueKeys.has(key)) return;
      if (!isFreshRecord && existing.multiValues.has(key)) return;
      this.pendingValueKeys.add(key);
      existing.multiValues.add(key);
    }
    this.values.push(prepared);
  }

  retireSingle(object_slug: string, record_id: string, attribute_slug: string): void {
    const key = singleValueKey(object_slug, record_id, attribute_slug);
    if (this.pendingRetireKeys.has(key)) return;
    this.pendingRetireKeys.add(key);
    this.singlesToRetire.push({ object_slug, record_id, attribute_slug });
  }

  async flush(): Promise<void> {
    if (this.records.length > 0) await this.flushRecords();
    if (this.singlesToRetire.length > 0) await this.flushSingleRetirements();
    if (this.values.length > 0) await this.flushValues();
  }

  private async flushRecords(): Promise<void> {
    for (const chunk of chunks(this.records, MAX_BATCH_ROWS)) {
      const placeholders = chunk
        .map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
        .join(", ");
      const params: LixRuntimeValue[] = chunk.flatMap((record) => [record.object_slug, record.record_id]);
      await exec(
        this.lix,
        `INSERT INTO acrm_record (object_slug, record_id) VALUES ${placeholders}`,
        params,
      );
    }
    this.records = [];
  }

  private async flushSingleRetirements(): Promise<void> {
    const now = nowIso();
    for (const chunk of chunks(this.singlesToRetire, MAX_BATCH_ROWS)) {
      const conditions = chunk
        .map((_, index) => {
          const base = index * 3 + 2;
          return `(object_slug = $${base} AND record_id = $${base + 1} AND attribute_slug = $${base + 2})`;
        })
        .join(" OR ");
      const params: LixRuntimeValue[] = [
        now,
        ...chunk.flatMap((target) => [target.object_slug, target.record_id, target.attribute_slug]),
      ];
      await exec(
        this.lix,
        `UPDATE acrm_value
         SET active_until = $1
         WHERE active_until IS NULL
           AND (${conditions})`,
        params,
      );
    }
    this.singlesToRetire = [];
  }

  private async flushValues(): Promise<void> {
    const COLS = 10;
    for (const chunk of chunks(this.values, MAX_BATCH_ROWS)) {
      const placeholders = chunk
        .map((_, index) => {
          const base = index * COLS;
          return `(${Array.from({ length: COLS }, (_, offset) => `$${base + offset + 1}`).join(", ")})`;
        })
        .join(", ");
      const params: LixRuntimeValue[] = chunk.flatMap((value) => [
        value.id,
        value.object_slug,
        value.record_id,
        value.attribute_slug,
        value.value_json,
        value.normalized_key,
        value.ref_object,
        value.ref_record_id,
        value.source,
        value.provenance_json,
      ]);
      await exec(
        this.lix,
        `INSERT INTO acrm_value
          (id, object_slug, record_id, attribute_slug, value_json,
           normalized_key, ref_object, ref_record_id, source, provenance_json)
         VALUES ${placeholders}`,
        params,
      );
    }
    this.values = [];
  }
}

function preparedValueKey(value: PreparedValueInsert): string | null {
  if (value.ref_object && value.ref_record_id) {
    return referenceValueKey(value.object_slug, value.record_id, value.attribute_slug, value.ref_object, value.ref_record_id);
  }
  if (value.normalized_key) {
    return normalizedValueKey(value.object_slug, value.record_id, value.attribute_slug, value.normalized_key);
  }
  return null;
}

function sourceIndexKey(objectSlug: string, sourceKey: string): string {
  return `${objectSlug}\0${sourceKey}`;
}

function singleValueKey(objectSlug: string, recordId: string, attributeSlug: string): string {
  return `${objectSlug}\0${recordId}\0${attributeSlug}`;
}

function normalizedValueKey(objectSlug: string, recordId: string, attributeSlug: string, normalizedKey: string): string {
  return `${singleValueKey(objectSlug, recordId, attributeSlug)}\0normalized\0${normalizedKey}`;
}

function referenceValueKey(objectSlug: string, recordId: string, attributeSlug: string, refObject: string, refRecordId: string): string {
  return `${singleValueKey(objectSlug, recordId, attributeSlug)}\0ref\0${refObject}\0${refRecordId}`;
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

function normalizeEmail(email: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized || undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function isObject(value: unknown): value is ValueJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
