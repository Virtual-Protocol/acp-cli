import {
  AcpAgent,
  ACP_CONTRACT_ADDRESSES,
  PrivyAlchemyEvmProviderAdapter,
  PRIVY_APP_ID,
  ACP_SERVER_URL,
  ACP_TESTNET_SERVER_URL,
  EVM_MAINNET_CHAINS,
  EVM_TESTNET_CHAINS,
  ERC20_SPONSORED_CHAINS,
  TESTNET_PRIVY_APP_ID,
  SseTransport,
  AcpApiClient,
  PrivySolanaProviderAdapter,
  getEvmChainByChainId,
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
} from "@virtuals-protocol/acp-node-v2";
import type {
  IEvmProviderAdapter,
  ISolanaProviderAdapter,
  SupportedStreams,
} from "@virtuals-protocol/acp-node-v2";
import {
  createAuthTokenStore,
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
import { base, baseSepolia } from "viem/chains";

type EvmChain = (typeof EVM_MAINNET_CHAINS)[number];

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
  const solanaChainId = isTestnet
    ? SOLANA_DEVNET_CHAIN_ID
    : SOLANA_MAINNET_CHAIN_ID;

  // Solana is optional: EVM-only agents (no Privy Solana wallet) must keep
  // working, so a missing Solana wallet omits the provider instead of failing
  // the whole agent. Any other construction error still propagates.
  let solanaProvider: ISolanaProviderAdapter | undefined;
  try {
    solanaProvider = await createSolanaProviderAdapter(solanaChainId);
  } catch (err) {
    if (!(err instanceof CliError && err.code === "NO_SOLANA_WALLET"))
      throw err;
  }

  return AcpAgent.create({
    contractAddresses: ACP_CONTRACT_ADDRESSES,
    evmProvider: await createProviderFromConfig(chains, serverUrl, privyAppId),
    solanaProvider,
    api: new AcpApiClient({ serverUrl }),
    transport: new SseTransport({ serverUrl }),
  });
}

/**
 * Create a provider adapter from config — shared between v2 agent and v1 adapter.
 */
async function createProviderFromConfig(
  chains: EvmChain[],
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

  // Local test override: point the wallet-RPC + agent-auth at a local
  // agentic-commerce-be (ACP_WALLET_RPC_URL) instead of the hardcoded ACP
  // server, so gas sponsorship (the /wallets/alchemy-rpc proxy + its filter)
  // can be exercised end-to-end locally. Falls back to the normal serverUrl.
  const walletRpcUrl = process.env.ACP_WALLET_RPC_URL?.trim() || serverUrl;
  const tokenStore = await createAuthTokenStore(walletRpcUrl, walletAddress);
  return PrivyAlchemyEvmProviderAdapter.create({
    walletAddress: walletAddress as `0x${string}`,
    walletId,
    signFn,
    chains,
    serverUrl: walletRpcUrl,
    privyAppId,
    builderCode,
    tokenStore,
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
  const chainId = isTestnet ? baseSepolia.id : base.id;
  const chain = getEvmChainByChainId(chainId);
  if (!chain) {
    throw new CliError(`Unsupported chain id: ${chainId}`, "VALIDATION_ERROR");
  }
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
  // Use the full sponsored-chain set (not just Base): the adapter builds its
  // app-sponsored gas clients (acpClients) from this list, so a trade whose
  // source tx is on BSC/Arbitrum/etc. would otherwise fail "ACP not configured
  // for chainId <n>" the moment it takes the sponsored sendCalls path. Mirrors
  // the chains the ERC20 paymaster already covers.
  const chains = isTestnet ? EVM_TESTNET_CHAINS : ERC20_SPONSORED_CHAINS;
  return createProviderFromConfig(chains, serverUrl, privyAppId);
}

export async function createSseTransport(
  provider: IEvmProviderAdapter,
  streams: SupportedStreams[]
): Promise<SseTransport> {
  const isTestnet = process.env.IS_TESTNET === "true";
  const serverUrl = isTestnet ? ACP_TESTNET_SERVER_URL : ACP_SERVER_URL;
  const [agentAddress, providerSupportedChainIds] = await Promise.all([
    provider.getAddress(),
    provider.getSupportedChainIds(),
  ]);

  const transport = new SseTransport({ serverUrl });
  transport.setContext({
    agentAddresses: { evm: agentAddress },
    contractAddresses: ACP_CONTRACT_ADDRESSES,
    providerSupportedChainIds,
    signMessage: (chainId, message) => provider.signMessage(chainId, message),
    getClientForChain: () => {
      throw new Error("getClientForChain is unavailable in the CLI transport.");
    },
  });
  await transport.connect(undefined, streams);
  return transport;
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
  chainId: number,
  opts?: { sponsored?: boolean }
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
    ...(opts?.sponsored === undefined ? {} : { sponsored: opts.sponsored }),
  });
}
