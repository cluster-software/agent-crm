import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AcrmError, ERR } from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";

const DEFAULT_SYNC_ENGINE_URL = "https://agent-crm-sync-engine.onrender.com";
const CLOUD_METADATA_FILENAME = ".agent-crm-cloud.json";

type CloudMetadata = {
  workspaceId?: string;
  createdAt?: string;
};

export function attachGmailSubcommand(parent: Command): void {
  parent
    .command("gmail")
    .description(
      "Connect Gmail through Agent CRM's hosted sync engine. Opens hosted Google OAuth and syncs people, email threads, and email messages into the cloud workspace.",
    )
    .action(async () => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);

      try {
        const workspaceFile = resolveWorkspacePath(root?.workspace);
        const workspaceDir = dirname(workspaceFile);
        const workspaceId = ensureCloudWorkspaceId(
          workspaceDir,
          process.env.ACRM_CLOUD_WORKSPACE_ID,
        );
        const syncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL ?? DEFAULT_SYNC_ENGINE_URL;
        const authUrl = gmailConnectUrl({
          syncEngineUrl,
          workspaceId,
          workspaceName: basename(workspaceDir),
        });

        if (!isJson()) {
          process.stdout.write(
            [
              "Open this URL to connect Gmail:",
              authUrl,
              "",
              "After OAuth, Gmail sync runs in the background through Agent CRM's hosted sync engine.",
              "",
            ].join("\n")
          );
          return;
        }

        ok({
          auth_url: authUrl,
          workspace_id: workspaceId,
          sync_engine_url: syncEngineUrl,
        });
      } catch (error) {
        if (error instanceof AcrmError) fail(error.message, error.code, error.hint);
        else fail(error instanceof Error ? error.message : String(error), ERR.IMPORT);
        process.exit(1);
      }
    });
}

function ensureCloudWorkspaceId(
  workspaceDir: string,
  preferredWorkspaceId?: string,
): string {
  const metadataPath = join(workspaceDir, CLOUD_METADATA_FILENAME);
  const existing = readCloudMetadata(metadataPath);
  if (existing.workspaceId) return existing.workspaceId;

  const workspaceId = preferredWorkspaceId || randomUUID();
  writeFileSync(
    metadataPath,
    `${JSON.stringify({
      ...existing,
      workspaceId,
      createdAt: existing.createdAt ?? new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8"
  );
  return workspaceId;
}

function readCloudMetadata(metadataPath: string): CloudMetadata {
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as CloudMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function gmailConnectUrl(input: {
  syncEngineUrl: string;
  workspaceId: string;
  workspaceName: string;
}): string {
  const url = new URL("/integrations/gmail/connect", input.syncEngineUrl);
  url.searchParams.set("workspace_id", input.workspaceId);
  url.searchParams.set("workspace_name", input.workspaceName || "Agent CRM workspace");
  return url.toString();
}

export const __test = {
  gmailConnectUrl
};
