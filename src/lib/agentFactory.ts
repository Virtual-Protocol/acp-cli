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
} from "@virtuals-protocol/acp-node-v2";
import type { IEvmProviderAdapter } from "@virtuals-protocol/acp-node-v2";
import {
  getActiveWallet,
  getPublicKey,
  getWalletId,
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
import { base, baseSepolia } from "viem/chains";

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

  const walletId = agent.walletProviders[0].metadata.walletId;

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

  return PrivyAlchemyEvmProviderAdapter.create({
    walletAddress: walletAddress as `0x${string}`,
    walletId,
    signFn,
    chains,
    serverUrl,
    privyAppId,
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
  const chains = isTestnet ? EVM_TESTNET_CHAINS : EVM_MAINNET_CHAINS;
  const serverUrl = isTestnet ? ACP_TESTNET_SERVER_URL : ACP_SERVER_URL;
  const privyAppId = isTestnet ? TESTNET_PRIVY_APP_ID : PRIVY_APP_ID;
  return createProviderFromConfig(chains, serverUrl, privyAppId);
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
