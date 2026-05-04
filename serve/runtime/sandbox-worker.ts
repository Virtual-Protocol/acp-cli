/**
 * Sandbox Worker
 *
 * Runs inside a worker thread with NO access to parent process env vars.
 * Loads the developer's handler, executes it with the provided input,
 * and sends the result back to the parent.
 *
 * This file runs in an isolated environment:
 *   - process.env is empty (set by parent via env: {})
 *   - No access to parent's memory
 *   - No access to signer keys
 */

import { workerData, parentPort } from "worker_threads";

async function run() {
  const { handlerPath, input } = workerData;

  // Dynamically import the developer's handler
  const handlerModule = await import(handlerPath);
  const handler = handlerModule.default;

  if (typeof handler !== "function") {
    throw new Error("handler.ts must export a default async function");
  }

  // Execute handler with the provided input
  const result = await handler(input);

  // Send result back to parent
  parentPort?.postMessage(result);
}

run().catch((err) => {
  // Send error back as a message the parent can catch
  parentPort?.postMessage({ error: err.message || String(err) });
  process.exit(1);
});
