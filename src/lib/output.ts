import type { Command } from "commander";
import { CliError } from "./errors";
import pc from "picocolors";

export function isJson(cmd: Command): boolean {
  return cmd.optsWithGlobals().json === true;
}

export function outputResult(
  json: boolean,
  data: Record<string, unknown>
): void {
  if (json) {
    process.stdout.write(JSON.stringify(data) + "\n");
  } else {
    for (const [key, value] of Object.entries(data)) {
      const display =
        typeof value === "object"
          ? JSON.stringify(value, null, 2)
          : String(value);
      console.log(`${key}: ${display}`);
    }
  }
}

export function outputError(
  json: boolean,
  errOrMessage: string | Error
): void {
  const message =
    typeof errOrMessage === "string"
      ? errOrMessage
      : errOrMessage.message;

  const isCliErr = errOrMessage instanceof CliError;

  if (json) {
    const payload: Record<string, string> = { error: message };
    if (isCliErr) {
      payload.code = errOrMessage.code;
      if (errOrMessage.recovery) payload.recovery = errOrMessage.recovery;
      if (errOrMessage.details) {
        for (const [key, value] of Object.entries(errOrMessage.details)) {
          payload[key] = String(value);
        }
      }
    }
    process.stdout.write(JSON.stringify(payload) + "\n");
  } else {
    console.error(pc.red(`Error: ${message}`));
    if (isCliErr && errOrMessage.recovery) {
      console.error(`  ${errOrMessage.recovery}`);
    }
  }
  process.exitCode = 1;
}

export function maskAddress(address: string): string {
  try {
    return address.slice(0, 6) + "..." + address.slice(-4);
  } catch (err) {
    return address;
  }
}

export function isTTY(): boolean {
  if ("NO_COLOR" in process.env) return false;
  if ("FORCE_COLOR" in process.env) return process.env.FORCE_COLOR !== "0";
  if (process.env.TERM === "dumb") return false;
  return process.stdout.isTTY === true;
}

// Format an ISO timestamp for human-readable output. `new Date(bad)`
// doesn't throw — it yields an Invalid Date object whose toLocaleString
// returns the literal string "Invalid Date". Check with isNaN on the
// epoch so malformed server timestamps fall back to the raw string
// instead of rendering as "Invalid Date" in tables.
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
