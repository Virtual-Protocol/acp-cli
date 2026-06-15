import {
  AcpAgent,
  ACP_CONTRACT_ADDRESSES,
  PrivyAlchemyEvmProviderAdapter,
  PRIVY_APP_ID,
  ACP_SERVER_URL,
  ACP_TESTNET_SERVER_URL,
  EVM_MAINNET_CHAINS,
  EVM_TESTNET_CHAINS,
  TESTNET_PRIVY_APP_ID,
  SseTransport,
  AcpApiClient,
  PrivySolanaProviderAdapter,
} from "@virtuals-protocol/acp-node-v2";
import type {
  IEvmProviderAdapter,
  ISolanaProviderAdapter,
} from "@virtuals-protocol/acp-node-v2";
import {
  getBuilderCode,
  getActiveWallet,
  getAgentId,
  getPublicKey,
  getWalletId,
  setBuilderCode,
  setWalletId,
} from "./config";
import { getClient } from "./api/client";
import { createSignFn } from "./acpCliSigner";
import {
  LegacyBuyerAdapter,
  type LegacyJobEventHandler,
} from "./compat/legacyBuyerAdapter";
import { CliError } from "./errors";
import { Chain } from "viem";
import { base, baseSepolia, mainnet, arbitrum, optimism, polygon, bsc } from "viem/chains";

export async function getWalletIdByAddress(
  walletAddress: string
): Promise<string> {
  const { agentApi } = await getClient();
  const agentList = await agentApi.list();
  const agent = agentList.data.find(
    (agent) => agent.walletAddress === walletAddress
  );

  if (!agent) {
    throw new Error(`Agent not found for wallet address: ${walletAddress}`);
  }

  const evmProvider = agent.walletProviders.find(
    (wp) => (wp.chainType ?? "EVM") === "EVM"
  );

  if (!evmProvider) {
    throw new Error(
      `EVM wallet provider not found for wallet address: ${walletAddress}`
    );
  }

  const walletId = evmProvider.metadata.walletId;

  if (!walletId) {
    throw new Error(`Wallet ID not found for wallet address: ${walletAddress}`);
  }

  return walletId;
}

export async function createAgentFromConfig(): Promise<AcpAgent> {
  const isTestnet = process.env.IS_TESTNET === "true";
  const chains = isTestnet ? EVM_TESTNET_CHAINS : EVM_MAINNET_CHAINS;
  const serverUrl = isTestnet ? ACP_TESTNET_SERVER_URL : ACP_SERVER_URL;
  const privyAppId = isTestnet ? TESTNET_PRIVY_APP_ID : PRIVY_APP_ID;

  return AcpAgent.create({
    contractAddresses: ACP_CONTRACT_ADDRESSES,
    provider: await createProviderFromConfig(chains, serverUrl, privyAppId),
    api: new AcpApiClient({ serverUrl }),
    transport: new SseTransport({ serverUrl }),
  });
}

/**
 * Create a provider adapter from config — shared between v2 agent and v1 adapter.
 */
async function createProviderFromConfig(
  chains: Chain[],
  serverUrl: string,
  privyAppId: string
): Promise<IEvmProviderAdapter> {
  const walletAddress = getActiveWallet();
  if (!walletAddress) {
    throw new CliError(
      "No active agent set.",
      "NO_ACTIVE_AGENT",
      "Run `acp agent create` or `acp agent use` to set an active agent."
    );
  }

  const publicKey = getPublicKey(walletAddress);
  if (!publicKey) {
    throw new CliError(
      "No signer configured for this agent.",
      "NO_SIGNER",
      "Run `acp agent add-signer` to generate and register a signing key."
    );
  }

  const walletId =
    getWalletId(walletAddress) ?? (await getWalletIdByAddress(walletAddress));
  setWalletId(walletAddress, walletId);

  const signFn = createSignFn(publicKey);

  let builderCode = getBuilderCode(walletAddress);
  if (!builderCode) {
    const agentId = getAgentId(walletAddress);
    if (agentId) {
      const { agentApi } = await getClient();
      const agentData = await agentApi.getById(agentId);
      setBuilderCode(agentData.walletAddress, agentData.builderCode);
      builderCode = agentData.builderCode;
    }
  }

  return PrivyAlchemyEvmProviderAdapter.create({
    walletAddress: walletAddress as `0x${string}`,
    walletId,
    signFn,
    chains,
    serverUrl,
    privyAppId,
    builderCode,
  });
}

/**
 * Create a LegacyBuyerAdapter for interacting with legacy (openclaw-cli) sellers.
 * Pass onNewTask to connect the old backend's socket and receive real-time events.
 */
export async function createLegacyBuyerAdapter(options?: {
  onNewTask?: LegacyJobEventHandler;
}): Promise<LegacyBuyerAdapter> {
  const isTestnet = process.env.IS_TESTNET === "true";
  const chain = isTestnet ? baseSepolia : base;
  const serverUrl = isTestnet ? ACP_TESTNET_SERVER_URL : ACP_SERVER_URL;
  const privyAppId = isTestnet ? TESTNET_PRIVY_APP_ID : PRIVY_APP_ID;

  const provider = await createProviderFromConfig(
    [chain],
    serverUrl,
    privyAppId
  );
  return LegacyBuyerAdapter.create(provider, chain.id, options);
}

/**
 * Create a provider adapter using the active wallet config.
 * Lightweight alternative to createAgentFromConfig() when only
 * signing / provider operations are needed.
 */
export async function createProviderAdapter(): Promise<IEvmProviderAdapter> {
  const isTestnet = process.env.IS_TESTNET === "true";
  const serverUrl = isTestnet ? ACP_TESTNET_SERVER_URL : ACP_SERVER_URL;
  const privyAppId = isTestnet ? TESTNET_PRIVY_APP_ID : PRIVY_APP_ID;
  // The trade command signs `send` legs the trading-agent returns on chains
  // beyond the SDK's default set (EVM_MAINNET_CHAINS is just [base]) — e.g.
  // Arbitrum bridge legs for HL deposits/withdrawals, or BSC/Polygon swaps.
  // The provider needs a viem Chain for each so it can build the client; bind
  // the EVM chains the trade flows can touch. (Listing a chain here only lets
  // it construct a client — end-to-end signing still requires SDK paymaster
  // support for that chain.)
  const extraMainnet: Chain[] = [mainnet, arbitrum, optimism, polygon, bsc];
  const baseChains = isTestnet ? EVM_TESTNET_CHAINS : EVM_MAINNET_CHAINS;
  const chains = isTestnet
    ? baseChains
    : dedupeChains([...baseChains, ...extraMainnet]);
  return createProviderFromConfig(chains, serverUrl, privyAppId);
}

export async function createSseTransport(
  provider: IEvmProviderAdapter
): Promise<SseTransport> {
  const isTestnet = process.env.IS_TESTNET === "true";
  const serverUrl = isTestnet ? ACP_TESTNET_SERVER_URL : ACP_SERVER_URL;
  const [agentAddress, providerSupportedChainIds] = await Promise.all([
    provider.getAddress(),
    provider.getSupportedChainIds(),
  ]);

  const ctx = {
    agentAddress,
    contractAddresses: ACP_CONTRACT_ADDRESSES,
    providerSupportedChainIds,
    signMessage: (chainId: number, message: string) =>
      provider.signMessage(chainId, message),
  } as unknown as Parameters<SseTransport["setContext"]>[0];

  const transport = new SseTransport({ serverUrl });
  transport.setContext(ctx);
  await transport.connect();
  return transport;
}

// Dedupe a chains list by id, keeping the first occurrence (so the SDK's own
// entries take precedence over our appended extras).
function dedupeChains(chains: Chain[]): Chain[] {
  const seen = new Set<number>();
  const out: Chain[] = [];
  for (const c of chains) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

export function getWalletAddress(): string {
  const addr = getActiveWallet();
  if (!addr) {
    throw new CliError(
      "No active agent set.",
      "NO_ACTIVE_AGENT",
      "Run `acp agent create` or `acp agent use` to set an active agent."
    );
  }
  return addr;
}

// ---------------------------------------------------------------------------
// Solana wallet
// ---------------------------------------------------------------------------

/**
 * Resolve the agent's Solana address + Privy wallet id from the server. The
 * Privy wallet hosts both the EVM and Solana addresses under the same signer,
 * so the same P256 signFn authorizes Solana operations too.
 */
async function getSolanaWalletInfo(
  walletAddress: string
): Promise<{ solWalletAddress: string; walletId: string }> {
  const { agentApi } = await getClient();
  const agentList = await agentApi.list();
  const agent = agentList.data.find((a) => a.walletAddress === walletAddress);
  if (!agent) {
    throw new CliError(
      `Agent not found for wallet address: ${walletAddress}`,
      "AGENT_NOT_FOUND"
    );
  }
  const solProvider = agent.walletProviders.find(
    (wp) => wp.chainType === "SOLANA"
  );
  if (!agent.solWalletAddress || !solProvider?.metadata.walletId) {
    throw new CliError(
      "This agent has no Solana wallet.",
      "NO_SOLANA_WALLET",
      "The agent's Privy wallet has no Solana provider configured."
    );
  }
  return {
    solWalletAddress: agent.solWalletAddress,
    walletId: solProvider.metadata.walletId,
  };
}

/** The active agent's Solana address. */
export async function getSolanaWalletAddress(): Promise<string> {
  const { solWalletAddress } = await getSolanaWalletInfo(getWalletAddress());
  return solWalletAddress;
}

/**
 * Build a Solana provider adapter for the active agent, reusing the same
 * P256 signFn as the EVM provider (RPC + signing are routed through the ACP
 * server proxy / Privy).
 */
export async function createSolanaProviderAdapter(
  chainId: number
): Promise<ISolanaProviderAdapter> {
  const isTestnet = process.env.IS_TESTNET === "true";
  const serverUrl = isTestnet ? ACP_TESTNET_SERVER_URL : ACP_SERVER_URL;
  const privyAppId = isTestnet ? TESTNET_PRIVY_APP_ID : PRIVY_APP_ID;

  const walletAddress = getWalletAddress();
  const publicKey = getPublicKey(walletAddress);
  if (!publicKey) {
    throw new CliError(
      "No signer configured for this agent.",
      "NO_SIGNER",
      "Run `acp agent add-signer` to generate and register a signing key."
    );
  }

  const { solWalletAddress, walletId } =
    await getSolanaWalletInfo(walletAddress);
  const signFn = createSignFn(publicKey);

  return PrivySolanaProviderAdapter.create({
    walletAddress: solWalletAddress,
    walletId,
    signFn,
    chainId,
    serverUrl,
    privyAppId,
  });
}
