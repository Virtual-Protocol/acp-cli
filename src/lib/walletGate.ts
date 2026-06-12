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

export async function withApprovalGate<T>(
  fn: (provider: IEvmProviderAdapter) => Promise<T>
): Promise<T> {
  const provider = await createProviderAdapter();
  const transport = await createSseTransport(provider, [STREAMS.WALLET]);
  try {
    return await fn(provider);
  } finally {
    void Promise.resolve(transport.disconnect()).catch(() => {});
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
