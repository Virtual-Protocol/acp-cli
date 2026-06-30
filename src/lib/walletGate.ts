import {
  STREAMS,
  type IEvmProviderAdapter,
  type ISolanaProviderAdapter,
} from "@virtuals-protocol/acp-node-v2";
import {
  createProviderAdapter,
  createSolanaProviderAdapter,
  createSseTransport,
} from "./agentFactory";

interface ApprovalGateOptions {
  json?: boolean;
}

interface SolanaApprovalGateOptions extends ApprovalGateOptions {
  chainId: number;
  sponsored?: boolean;
}

export function withApprovalGate<T>(
  fn: (provider: IEvmProviderAdapter) => Promise<T>,
  opts?: ApprovalGateOptions
): Promise<T>;

export function withApprovalGate<T>(
  fn: (provider: ISolanaProviderAdapter) => Promise<T>,
  opts: SolanaApprovalGateOptions
): Promise<T>;

export async function withApprovalGate<T>(
  fn: (provider: any) => Promise<T>,
  opts: ApprovalGateOptions & { chainId?: number; sponsored?: boolean } = {}
): Promise<T> {
  let transport: Awaited<ReturnType<typeof createSseTransport>> | undefined;
  const restoreApprovalConsole = mirrorApprovalConsoleToStderr(opts);
  try {
    const evmProvider = await createProviderAdapter();
    transport = await createSseTransport(evmProvider, [STREAMS.WALLET]);
    const provider =
      opts.chainId === undefined
        ? evmProvider
        : await createSolanaProviderAdapter(opts.chainId, {
            sponsored: opts.sponsored,
          });
    return await fn(provider);
  } finally {
    if (transport) {
      void Promise.resolve(transport.disconnect()).catch(() => {});
    }
    restoreApprovalConsole();
  }
}

function emitApprovalUrlToStderr(url: string): void {
  process.stderr.write(
    `\n>>> Manual approval required. Return this URL to the user:\n\n    ${url}\n\n`
  );
}

function mirrorApprovalConsoleToStderr(opts: ApprovalGateOptions): () => void {
  if (!opts.json) return () => {};

  const original = console.error;
  const seen = new Set<string>();

  console.error = (...args: unknown[]) => {
    original(...args);

    const url = approvalUrlFromConsoleArgs(args);
    if (!url || seen.has(url)) return;

    seen.add(url);
    emitApprovalUrlToStderr(url);
  };

  return () => {
    console.error = original;
  };
}

function approvalUrlFromConsoleArgs(args: unknown[]): string | undefined {
  const text = args
    .map((arg) => (typeof arg === "string" ? arg : ""))
    .join("\n");

  if (!text.includes("Manual approval required")) return undefined;

  const match = text.match(/Approve at:\s*(https?:\/\/[^\s]+)/i);
  return match?.[1];
}
