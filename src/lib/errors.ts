export type ErrorCode =
  | "NOT_AUTHENTICATED"
  | "NO_ACTIVE_AGENT"
  | "NO_SIGNER"
  | "SESSION_NOT_FOUND"
  | "VALIDATION_ERROR"
  | "API_ERROR"
  | "ALREADY_EXISTS"
  | "TIMEOUT";

export class CliError extends Error {
  code: ErrorCode;
  recovery?: string;

  constructor(message: string, code: ErrorCode, recovery?: string) {
    super(message);
    this.code = code;
    this.recovery = recovery;
  }
}
