export type ErrorCode =
  | "NOT_AUTHENTICATED"
  | "NO_ACTIVE_AGENT"
  | "NO_SIGNER"
  | "AGENT_NOT_FOUND"
  | "NO_SOLANA_WALLET"
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

  constructor(message: string, code: ErrorCode, recovery?: string) {
    super(message);
    this.code = code;
    this.recovery = recovery;
  }
}
