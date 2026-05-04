/**
 * Logger
 *
 * Writes structured JSON log lines to files in ~/.acp/serve/logs/.
 * Used by the offering server for request logging, handler execution,
 * and 8183 settlement tracking.
 *
 * Also outputs to console for local dev mode.
 */

import { appendFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

const LOG_DIR = resolve(homedir(), ".acp", "serve", "logs");

let initialized = false;

function ensureDir(): void {
  if (!initialized) {
    mkdirSync(LOG_DIR, { recursive: true });
    initialized = true;
  }
}

export type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  offeringId: string;
  jobId?: string;
  protocol?: string;
  message: string;
  data?: Record<string, unknown>;
}

export function log(
  level: LogLevel,
  offeringId: string,
  message: string,
  extra?: { jobId?: string; protocol?: string; data?: Record<string, unknown> }
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    offeringId,
    message,
    ...extra,
  };

  // Console output
  const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
  console.log(`[${prefix}] [${offeringId}] ${message}`);

  // File output
  ensureDir();
  const logFile = resolve(LOG_DIR, `${offeringId}.log`);
  appendFileSync(logFile, JSON.stringify(entry) + "\n");
}

export function getLogDir(): string {
  return LOG_DIR;
}
