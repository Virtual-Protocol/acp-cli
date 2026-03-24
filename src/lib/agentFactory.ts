import {
  AcpAgent,
  ACP_CONTRACT_ADDRESS,
  AlchemyEvmProviderAdapter,
  PrivyAlchemyEvmProviderAdapter,
} from "acp-node-v2";
import { getPublicKey } from "./config";
import { getAgentApi } from "./api/agent";
import { loadSignerKey } from "./signerKeychain.js";

export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

// Base Sepolia chain config matching @account-kit/infra's baseSepolia.
// Defined inline to avoid importing @account-kit/infra directly (prevents
// duplicate-package type conflicts with the SDK's own copy).
const BASE_SEPOLIA_CHAIN = {
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://sepolia.base.org"] },
  },
  testnet: true,
} as const;

const agentApi = getAgentApi();

export async function getWalletIdByAddress(
  walletAddress: string
): Promise<string> {
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

export async function createAgentFromEnv(): Promise<AcpAgent> {
  const providerType = process.env.ACP_PROVIDER_TYPE ?? "privy";
  const walletAddress = requireEnv("ACP_WALLET_ADDRESS");
  const socketUrl =
    process.env.ACP_SOCKET_SERVER_URL ?? "http://localhost:3000";
  const contractAddress =
    process.env.ACP_CONTRACT_ADDRESS ?? ACP_CONTRACT_ADDRESS;

  let provider;

  if (providerType === "privy") {
    const publicKey = getPublicKey(walletAddress);
    const walletId = await getWalletIdByAddress(walletAddress);

    const signerPrivateKey = publicKey ? await loadSignerKey(publicKey) : null;

    provider = await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: walletAddress as `0x${string}`,
      walletId,
      ...(signerPrivateKey
        ? { signerPrivateKey: signerPrivateKey }
        : { signerPrivateKey: requireEnv("ACP_SIGNER_PRIVATE_KEY") }),
    });
  } else {
    provider = await AlchemyEvmProviderAdapter.create({
      walletAddress: walletAddress as `0x${string}`,
      privateKey: requireEnv("ACP_PRIVATE_KEY") as `0x${string}`,
      entityId: Number(process.env.ACP_ENTITY_ID ?? "1"),
      chain: BASE_SEPOLIA_CHAIN as any,
    });
  }

  return AcpAgent.create({
    contractAddress,
    provider,
    transport: { type: "socket", url: socketUrl },
  });
}

export function getWalletAddress(): string {
  return requireEnv("ACP_WALLET_ADDRESS");
}

export function getSocketUrl(): string {
  return process.env.ACP_SOCKET_SERVER_URL ?? "http://localhost:3000";
}
