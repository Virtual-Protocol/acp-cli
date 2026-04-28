import { parentPort, workerData } from "worker_threads";

async function main() {
  const { handlerPath, input } = workerData as {
    handlerPath: string;
    input: unknown;
  };
  const originalEnv = process.env;
  process.env = {};

  try {
    const mod = await import(handlerPath);
    const result = await mod.default(input);
    parentPort?.postMessage({ ok: true, result });
  } catch (err) {
    parentPort?.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    process.env = originalEnv;
  }
}

main().catch((err) => {
  parentPort?.postMessage({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
});
