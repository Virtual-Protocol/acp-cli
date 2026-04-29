import { Worker } from "worker_threads";
import type { HandlerInput, HandlerOutput } from "../types";

export function runInSandbox(
  handlerPath: string,
  input: HandlerInput,
  timeoutMs: number
): Promise<HandlerOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sandbox-worker.ts", import.meta.url), {
      workerData: { handlerPath, input },
    });

    const timeout = setTimeout(() => {
      worker.terminate().catch(() => {});
      reject(new Error(`Handler timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    worker.on("message", (message: { ok: boolean; result?: HandlerOutput; error?: string }) => {
      clearTimeout(timeout);
      if (message.ok) resolve(message.result!);
      else reject(new Error(message.error ?? "Handler failed"));
    });
    worker.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
