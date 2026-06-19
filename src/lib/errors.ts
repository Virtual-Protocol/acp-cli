export type ErrorCode =
  | "NOT_AUTHENTICATED"
  | "NO_ACTIVE_AGENT"
  | "NO_SIGNER"
  | "SESSION_NOT_FOUND"
  | "VALIDATION_ERROR"
  | "API_ERROR"
  | "ALREADY_EXISTS"
  | "ALREADY_TOKENIZED"
  | "TIMEOUT"
  | "SLIPPAGE_TOO_LOW"
  | "INSUFFICIENT_GAS"
  | "APPROVAL_REQUIRED";

export class CliError extends Error {
  code: ErrorCode;
  recovery?: string;
  details?: Record<string, string | number | boolean>;

  constructor(
    message: string,
    code: ErrorCode,
    recovery?: string,
    details?: Record<string, string | number | boolean>
  ) {
    super(message);
    this.code = code;
    this.recovery = recovery;
    this.details = details;
  }
}
