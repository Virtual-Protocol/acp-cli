import {
  createPublicClient,
  http,
  verifyTypedData,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const SUPPORTED_CHAINS = [base, baseSepolia];

export function getDefaultChainId(): number {
  return Number(process.env.ACP_CHAIN_ID || base.id);
}

export function getChain(chainId = getDefaultChainId()): Chain {
  const chain = SUPPORTED_CHAINS.find((candidate) => candidate.id === chainId);
  if (!chain) throw new Error(`Unsupported chain ${chainId}`);
  return chain;
}

export function getRpcUrl(chainId = getDefaultChainId()): string | undefined {
  return process.env[`CUSTOM_RPC_URL_${chainId}`];
}

export function getPublicClient(chainId = getDefaultChainId()) {
  return createPublicClient({
    chain: getChain(chainId),
    transport: http(getRpcUrl(chainId)),
  });
}

export function getSettlementAccount() {
  const privateKey =
    process.env.ACP_SIGNER_PRIVATE_KEY ||
    process.env.DEPLOY_SIGNER_KEY ||
    process.env.GATEWAY_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "Provider settlement signer is not configured. Set ACP_SIGNER_PRIVATE_KEY."
    );
  }
  return privateKeyToAccount(privateKey as Hex, { nonceManager });
}

export { verifyTypedData };
