import {
  AcpAgent,
  ACP_CONTRACT_ADDRESSES,
  PrivyAlchemyEvmProviderAdapter,
} from "acp-node-v2";
import {
  getActiveWallet,
  getPublicKey,
  getWalletId,
  setWalletId,
} from "./config";
import { getClient } from "./api/client";
import { loadSignerKey } from "./signerKeychain";
import { CliError } from "./errors";

export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

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

  const signerPrivateKey = await loadSignerKey(publicKey);
  if (!signerPrivateKey) {
    throw new CliError(
      "Signer key not found in keychain.",
      "NO_SIGNER",
      "Run `acp agent add-signer` to regenerate the signing key."
    );
  }

  const provider = await PrivyAlchemyEvmProviderAdapter.create({
    walletAddress: walletAddress as `0x${string}`,
    walletId,
    signerPrivateKey,
  });

  return AcpAgent.create({
    contractAddresses: ACP_CONTRACT_ADDRESSES,
    provider,
  });
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
