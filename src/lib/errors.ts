export class AcrmError extends Error {
  constructor(
    message: string,
    public code: string,
    public hint?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AcrmError";
  }
}

export const ERR = {
  NO_WORKSPACE: "ACRM_ERROR_NO_WORKSPACE",
  WORKSPACE_EXISTS: "ACRM_ERROR_WORKSPACE_EXISTS",
  NOT_FOUND: "ACRM_ERROR_NOT_FOUND",
  INVALID_INPUT: "ACRM_ERROR_INVALID_INPUT",
  UNIQUE_VIOLATION: "ACRM_ERROR_UNIQUE_VIOLATION",
  EXECUTE: "ACRM_ERROR_EXECUTE",
  IMPORT: "ACRM_ERROR_IMPORT",
  INIT: "ACRM_ERROR_INIT",
  UI: "ACRM_ERROR_UI",
  UNHANDLED: "ACRM_ERROR_UNHANDLED",
} as const;
