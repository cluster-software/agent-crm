export class AcrmError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "AcrmError";
  }
}

export const ERR = {
  NO_WORKSPACE: "ERR_NO_WORKSPACE",
  WORKSPACE_EXISTS: "ERR_WORKSPACE_EXISTS",
  NOT_FOUND: "ERR_NOT_FOUND",
  INVALID_INPUT: "ERR_INVALID_INPUT",
  UNIQUE_VIOLATION: "ERR_UNIQUE_VIOLATION",
  MERGE_CONFLICT: "ERR_MERGE_CONFLICT",
  WRITE_REJECTED: "ERR_WRITE_REJECTED",
} as const;
