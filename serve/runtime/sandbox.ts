import { Worker } from "worker_threads";
import type { HandlerInput, HandlerOutput } from "../types";

export function runInSandbox(
  handlerPath: string,
  input: HandlerInput,
  timeoutMs: number,
): Promise<HandlerOutput> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout;
    const worker = new Worker(new URL("./sandbox-worker.ts", import.meta.url), {
      workerData: { handlerPath, input },
    });

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    timeout = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(() => reject(new Error(`Handler timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    worker.once(
      "message",
      (message: { ok: boolean; result?: HandlerOutput; error?: string }) => {
        finish(() => {
          if (message.ok) resolve(message.result!);
          else reject(new Error(message.error ?? "Handler failed"));
        });
      },
    );
    worker.once("error", (err) => {
      finish(() => reject(err));
    });
    worker.once("exit", (code) => {
      if (code === 0) {
        finish(() =>
          reject(new Error("Handler exited before returning a result")),
        );
        return;
      }
      finish(() =>
        reject(new Error(`Handler worker exited with code ${code}`)),
      );
    });
  });
}
