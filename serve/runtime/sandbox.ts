/**
 * Handler Sandbox
 *
 * Runs the developer's handler.ts in an isolated worker thread.
 * The worker has NO access to:
 *   - process.env (no signer keys, no secrets)
 *   - filesystem (no reading config files)
 *   - parent process memory
 *
 * The worker only receives the HandlerInput and returns HandlerOutput.
 * This prevents malicious handlers from stealing the deploy signer key
 * or accessing other sensitive data.
 */

import { Worker } from "worker_threads";
import { resolve } from "path";
import type { HandlerInput, HandlerOutput } from "../types";

// Worker script path — in production this would be the compiled sandbox-worker.js
const WORKER_SCRIPT = resolve(__dirname, "sandbox-worker.ts");

/**
 * Execute a handler in a sandboxed worker thread.
 *
 * @param handlerPath - Absolute path to handler.ts
 * @param input - Handler input (requirements, offering, client info)
 * @param timeoutMs - Maximum execution time before killing the worker
 * @returns Handler output (deliverable)
 */
export function runInSandbox(
  handlerPath: string,
  input: HandlerInput,
  timeoutMs: number
): Promise<HandlerOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SCRIPT, {
      workerData: { handlerPath, input },
      env: {}, // EMPTY — no access to DEPLOY_SIGNER_KEY or any secrets
    });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`Handler timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    worker.on("message", (result: HandlerOutput) => {
      clearTimeout(timer);
      resolve(result);
    });

    worker.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Handler worker exited with code ${code}`));
      }
    });
  });
}
