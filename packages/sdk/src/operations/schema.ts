import type { LixRuntimeValue } from "@lix-js/sdk";
import { exec } from "../db/execute.js";
import type { AttributeType, StatusOption } from "../domain/values.js";
import { AcrmError, ERR } from "../lib/errors.js";
import {
  assertObjectExists,
  loadAttribute,
  loadObject,
} from "../workspace/catalog.js";
import type { Workspace } from "../workspace.js";

export type CreateObjectInput = {
  object_slug: string;
  singular_name: string;
  plural_name: string;
};

export type CreateObjectResult = {
  object_slug: string;
  singular_name: string;
  plural_name: string;
};

export async function createObject(
  workspace: Workspace,
  input: CreateObjectInput,
): Promise<CreateObjectResult> {
  if (await loadObject(workspace.lix, input.object_slug)) {
    throw new AcrmError(
      `object already exists: ${input.object_slug}`,
      ERR.UNIQUE_VIOLATION,
    );
  }
  await exec(
    workspace.lix,
    "INSERT INTO acrm_object (object_slug, singular_name, plural_name) VALUES ($1, $2, $3)",
    [input.object_slug, input.singular_name, input.plural_name],
  );
  return {
    object_slug: input.object_slug,
    singular_name: input.singular_name,
    plural_name: input.plural_name,
  };
}

export type AddAttributeInput = {
  object_slug: string;
  attribute_slug: string;
  attribute_type: AttributeType;
  title: string;
  is_multivalued: boolean;
  is_unique: boolean;
  config: Record<string, unknown> | null;
};

export type AddAttributeResult = {
  object_slug: string;
  attribute_slug: string;
  attribute_type: AttributeType;
  is_multivalued: boolean;
  is_unique: boolean;
  config?: Record<string, unknown>;
};

export async function addAttribute(
  workspace: Workspace,
  input: AddAttributeInput,
): Promise<AddAttributeResult> {
  await assertObjectExists(workspace.lix, input.object_slug);
  if (input.config && input.config.target_object) {
    await assertObjectExists(workspace.lix, input.config.target_object as string);
  }
  if (await loadAttribute(workspace.lix, input.object_slug, input.attribute_slug)) {
    throw new AcrmError(
      `attribute already exists: ${input.object_slug}.${input.attribute_slug}`,
      ERR.UNIQUE_VIOLATION,
    );
  }
  const params: LixRuntimeValue[] = [
    input.object_slug,
    input.attribute_slug,
    input.title,
    input.attribute_type,
    input.is_multivalued,
    input.is_unique,
    input.config ? JSON.stringify(input.config) : null,
  ];
  await exec(
    workspace.lix,
    `INSERT INTO acrm_attribute
      (object_slug, attribute_slug, title, attribute_type, is_multivalued, is_unique, config_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    params,
  );
  return {
    object_slug: input.object_slug,
    attribute_slug: input.attribute_slug,
    attribute_type: input.attribute_type,
    is_multivalued: input.is_multivalued,
    is_unique: input.is_unique,
    ...(input.config ? { config: input.config } : {}),
  };
}

export type EditAttributeOptionsInput = {
  object_slug: string;
  attribute_slug: string;
} & (
  | { action: "add"; option: StatusOption }
  | { action: "remove"; option_id: string }
);

export type EditAttributeOptionsResult = {
  object_slug: string;
  attribute_slug: string;
  attribute_type: AttributeType;
  options: StatusOption[];
};

export async function editAttributeOptions(
  workspace: Workspace,
  input: EditAttributeOptionsInput,
): Promise<EditAttributeOptionsResult> {
  const attr = await loadAttribute(
    workspace.lix,
    input.object_slug,
    input.attribute_slug,
  );
  if (!attr) {
    throw new AcrmError(
      `attribute not found: ${input.object_slug}.${input.attribute_slug}`,
      ERR.NOT_FOUND,
    );
  }
  if (attr.attribute_type !== "status" && attr.attribute_type !== "select") {
    throw new AcrmError(
      `edit-options is only valid for status/select attributes; ${input.object_slug}.${input.attribute_slug} is ${attr.attribute_type}`,
      ERR.INVALID_INPUT,
    );
  }

  const current = attr.config?.options ?? [];
  let next: StatusOption[];
  if (input.action === "add") {
    if (current.some((o) => o.id === input.option.id)) {
      throw new AcrmError(
        `option already exists: ${input.option.id}`,
        ERR.UNIQUE_VIOLATION,
      );
    }
    next = [...current, input.option];
  } else {
    const id = input.option_id;
    if (!current.some((o) => o.id === id)) {
      throw new AcrmError(
        `option not found: ${id} (current: ${current.map((o) => o.id).join(", ") || "<none>"})`,
        ERR.NOT_FOUND,
      );
    }
    next = current.filter((o) => o.id !== id);
  }

  const nextConfig: Record<string, unknown> = {
    ...(attr.config ?? {}),
    options: next,
  };
  await exec(
    workspace.lix,
    "UPDATE acrm_attribute SET config_json = $1 WHERE object_slug = $2 AND attribute_slug = $3",
    [JSON.stringify(nextConfig), input.object_slug, input.attribute_slug],
  );
  return {
    object_slug: input.object_slug,
    attribute_slug: input.attribute_slug,
    attribute_type: attr.attribute_type,
    options: next,
  };
}
