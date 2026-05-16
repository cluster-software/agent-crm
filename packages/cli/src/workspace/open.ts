// Back-compat shim. Existing CLI command callers do
//   const lix = await openWorkspace({ workspace, create });
// and operate on the raw Lix without closing it. New code should use
// Workspace.open() / Workspace.create() from @agent-crm/sdk directly and
// call workspace.close() in finally. This shim will be removed once every
// command migrates (Phase 3).

import type { Lix } from "@lix-js/sdk";
import { Workspace } from "@agent-crm/sdk";
import { findWorkspace, resolveWorkspacePath } from "../workspace-resolve.js";

export { findWorkspace };

export async function openWorkspace(opts?: {
  workspace?: string;
  create?: boolean;
}): Promise<Lix> {
  const file = resolveWorkspacePath(opts?.workspace);
  const ws = opts?.create
    ? await Workspace.create(file)
    : await Workspace.open(file);
  return ws.lix;
}
