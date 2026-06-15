import type {
  IEvmProviderAdapter,
  ISolanaProviderAdapter,
} from "@virtuals-protocol/acp-node-v2";
import {
  createProviderAdapter,
  createSolanaProviderAdapter,
  createSseTransport,
} from "./agentFactory";
import { CliError } from "./errors";

interface ApprovalGateOptions {
  json?: boolean;
}

export async function withApprovalGate<T>(
  fn: (provider: IEvmProviderAdapter) => Promise<T>,
  opts: ApprovalGateOptions = {}
): Promise<T> {
  let transport: Awaited<ReturnType<typeof createSseTransport>> | undefined;
  try {
    const provider = await createProviderAdapter();
    transport = await createSseTransport(provider);
    return await fn(provider);
  } catch (err) {
    throw normalizeApprovalUrlError(err, opts);
  } finally {
    if (transport) {
      void Promise.resolve(transport.disconnect()).catch(() => {});
    }
  }
}

// Solana wallet operations sign + broadcast through the ACP server proxy /
// Privy directly (no EVM-style approval SSE stream), so this simply builds the
// Solana provider for the resolved chainId and runs the operation.
export async function withSolanaWallet<T>(
  chainId: number,
  fn: (provider: ISolanaProviderAdapter) => Promise<T>
): Promise<T> {
  const provider = await createSolanaProviderAdapter(chainId);
  return fn(provider);
}

function normalizeApprovalUrlError(
  err: unknown,
  opts: ApprovalGateOptions
): unknown {
  const url = extractApprovalUrl(err);
  if (!url) return err;

  if (opts.json) emitApprovalUrlToStderr(url);

  return new CliError(
    `Manual approval is required. Return this URL to the user as plain visible text so they can approve it: ${url}`,
    "APPROVAL_REQUIRED",
    "Do not hide the URL in tool output. Stop and show the raw URL before continuing."
  );
}

function emitApprovalUrlToStderr(url: string): void {
  process.stderr.write(
    `\n>>> Manual approval required. Return this URL to the user:\n\n    ${url}\n\n`
  );
}

function extractApprovalUrl(
  value: unknown,
  seen = new Set<unknown>()
): string | undefined {
  if (typeof value === "string") {
    return isApprovalText(value) ? firstUrl(value) : undefined;
  }

  if (value instanceof Error) {
    return (
      (isApprovalText(value.message) ? firstUrl(value.message) : undefined) ??
      extractObjectApprovalUrl(
        value as unknown as Record<string, unknown>,
        seen
      )
    );
  }

  if (value && typeof value === "object") {
    return extractObjectApprovalUrl(value as Record<string, unknown>, seen);
  }

  return undefined;
}

function extractObjectApprovalUrl(
  value: Record<string, unknown>,
  seen: Set<unknown>
): string | undefined {
  if (seen.has(value)) return undefined;
  seen.add(value);

  for (const key of ["approvalUrl", "approvalURL", "approval_url"]) {
    const url = firstUrl(value[key]);
    if (url) return url;
  }

  if (isApprovalPayload(value)) {
    const url = firstUrl(value.url);
    if (url) return url;
  }

  for (const key of ["data", "details", "cause"]) {
    const url = extractApprovalUrl(value[key], seen);
    if (url) return url;
  }

  for (const key of ["message", "error", "detail", "recovery"]) {
    const text = value[key];
    if (isApprovalText(text)) return firstUrl(text);
  }

  return undefined;
}

function isApprovalPayload(value: Record<string, unknown>): boolean {
  return (
    isApprovalText(value.code) ||
    isApprovalText(value.name) ||
    isApprovalText(value.message) ||
    isApprovalText(value.error) ||
    isApprovalText(value.detail)
  );
}

function isApprovalText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /approval|approve|manual[_ -]?review|user[_ -]?confirmation/i.test(value)
  );
}

function firstUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/https?:\/\/[^\s"'<>]+/i);
  return match?.[0].replace(/[),.;]+$/, "");
}
