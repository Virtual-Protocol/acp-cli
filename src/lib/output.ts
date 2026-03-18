import type { Command } from "commander";

export function isJson(cmd: Command): boolean {
  return cmd.optsWithGlobals().json === true;
}

export function outputResult(json: boolean, data: Record<string, unknown>): void {
  if (json) {
    process.stdout.write(JSON.stringify(data) + "\n");
  } else {
    for (const [key, value] of Object.entries(data)) {
      const display =
        typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
      console.log(`${key}: ${display}`);
    }
  }
}

export function outputError(json: boolean, message: string): void {
  if (json) {
    process.stdout.write(JSON.stringify({ error: message }) + "\n");
  } else {
    console.error(`Error: ${message}`);
  }
  process.exitCode = 1;
}
