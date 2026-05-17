import { generateUuid } from "../lib/ids.js";
import { Workspace } from "../workspace.js";

export { initializeWorkspace } from "../workspace/initialize.js";
export { seedAttributes, seedObjects } from "../workspace/seeds.js";

export type CreateWorkspaceResult = {
  workspace: Workspace;
  workspaceId: string;
};

// Functional compatibility wrapper around the canonical Workspace lifecycle.
// New code can call Workspace.create() directly when it does not need the
// generated workspace id.
export async function createWorkspace(
  absolutePath: string,
): Promise<CreateWorkspaceResult> {
  const workspace = await Workspace.create(absolutePath);
  const workspaceId = await generateUuid(workspace.lix);
  return { workspace, workspaceId };
}

export async function openWorkspace(absolutePath: string): Promise<Workspace> {
  return Workspace.open(absolutePath);
}
