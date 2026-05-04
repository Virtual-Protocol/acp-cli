import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  verifyTypedData,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import {
  base,
  baseSepolia,
  bsc,
  bscTestnet,
  mainnet,
  sepolia,
  xLayer,
  xLayerTestnet,
} from "viem/chains";

const SUPPORTED_CHAINS = [
  mainnet,
  sepolia,
  base,
  baseSepolia,
  bsc,
  bscTestnet,
  xLayer,
  xLayerTestnet,
];

const USDC_ADDRESSES: Record<number, Address> = {
  [baseSepolia.id]: "0xB270EDc833056001f11a7828DFdAC9D4ac2b8344",
  [base.id]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [bsc.id]: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  [bscTestnet.id]: "0x64544969ed7EBf5f083679233325356EbE738930",
  [xLayer.id]: "0x74b7f16337b8972027f6196a17a631ac6de26d22",
  [xLayerTestnet.id]: "0xcb8bf24c6ce16ad21d707c9505421a17f2bec79d",
};

const USDC_DECIMALS: Record<number, number> = {
  [baseSepolia.id]: 6,
  [base.id]: 6,
  [bsc.id]: 18,
  [bscTestnet.id]: 18,
  [xLayer.id]: 6,
  [xLayerTestnet.id]: 6,
};

export function getDefaultChainId(): number {
  return Number(process.env.ACP_CHAIN_ID || "84532");
}

export function getChain(chainId = getDefaultChainId()): Chain {
  const chain = SUPPORTED_CHAINS.find((candidate) => candidate.id === chainId);
  if (!chain) throw new Error(`Unsupported chain ${chainId}`);
  return chain;
}

export function getRpcUrl(chainId = getDefaultChainId()): string | undefined {
  return (
    process.env[`CUSTOM_RPC_URL_${chainId}`] ||
    process.env[`RPC_URL_${chainId}`] ||
    process.env.GATEWAY_RPC_URL
  );
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
      "Provider settlement signer is not configured. Set ACP_SIGNER_PRIVATE_KEY.",
    );
  }
  return privateKeyToAccount(privateKey as Hex, { nonceManager });
}

export function getWalletClient(chainId = getDefaultChainId()) {
  return createWalletClient({
    account: getSettlementAccount(),
    chain: getChain(chainId),
    transport: http(getRpcUrl(chainId)),
  });
}

export function getUsdcAddress(chainId = getDefaultChainId()): Address {
  const configured = process.env[`USDC_ADDRESS_${chainId}`];
  const address = configured || USDC_ADDRESSES[chainId];
  if (!address)
    throw new Error(`USDC address is not configured for ${chainId}`);
  return address as Address;
}

export async function getTokenDecimals(
  chainId = getDefaultChainId(),
  tokenAddress = getUsdcAddress(chainId),
): Promise<number> {
  const configured = process.env[`USDC_DECIMALS_${chainId}`];
  if (configured) return Number(configured);
  if (USDC_DECIMALS[chainId]) return USDC_DECIMALS[chainId];
  const decimals = await getPublicClient(chainId).readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "decimals",
  });
  return Number(decimals);
}

export function toAtomicAmount(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid payment amount: ${amount}`);
  }
  const [whole, fraction = ""] = String(amount).split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return (
    BigInt(whole || "0") * 10n ** BigInt(decimals) +
    BigInt(paddedFraction || "0")
  ).toString();
}

export { verifyTypedData };
