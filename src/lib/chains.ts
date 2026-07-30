import {
  ERC20_SPONSORED_CHAINS,
  getEvmChainByChainId,
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
} from "@virtuals-protocol/acp-node-v2";
import { CliError } from "./errors";

// Resolve the Solana chainId for the `wallet sol` commands. The cluster is
// implied by the environment (testnet → devnet, mainnet → mainnet), with an
// optional explicit override. The user never passes a numeric chain id.
export function solanaChainId(cluster?: string): number {
  if (cluster) {
    const c = cluster.toLowerCase();
    if (c === "devnet") return SOLANA_DEVNET_CHAIN_ID;
    if (c === "mainnet" || c === "mainnet-beta") return SOLANA_MAINNET_CHAIN_ID;
    throw new CliError(
      `Unknown Solana cluster "${cluster}".`,
      "VALIDATION_ERROR",
      "Use --cluster devnet or --cluster mainnet."
    );
  }
  return process.env.IS_TESTNET === "true"
    ? SOLANA_DEVNET_CHAIN_ID
    : SOLANA_MAINNET_CHAIN_ID;
}

export const SPONSORED_CHAIN_IDS = ERC20_SPONSORED_CHAINS.map(
  (chain) => chain.id
);

export function getEnvSponsoredChainIds(): number[] {
  const isTestnet = process.env.IS_TESTNET === "true";
  return ERC20_SPONSORED_CHAINS.filter(
    (chain) => Boolean(chain.testnet) === isTestnet
  ).map((chain) => chain.id);
}

export function isSolanaChainId(id: number): boolean {
  return id === SOLANA_DEVNET_CHAIN_ID || id === SOLANA_MAINNET_CHAIN_ID;
}

export function getNativeCurrency(
  chainId: number
): { name: string; symbol: string; decimals: number } | undefined {
  if (isSolanaChainId(chainId)) {
    return { name: "Solana", symbol: "SOL", decimals: 9 };
  }
  return ERC20_SPONSORED_CHAINS.find((chain) => chain.id === chainId)
    ?.nativeCurrency;
}

export function formatChainId(id: number): string {
  const chain = getEvmChainByChainId(id);
  return chain ? `${id} (${chain.name})` : String(id);
}

export function formatChainIds(ids: number[]): string {
  return ids.map(formatChainId).join(", ");
}

export function assertSponsoredChainId(chainId: number): void {
  if (!SPONSORED_CHAIN_IDS.includes(chainId)) {
    throw new CliError(
      `Unsupported chain ID: ${formatChainId(chainId)}`,
      "VALIDATION_ERROR",
      `Supported chains: ${formatChainIds(SPONSORED_CHAIN_IDS)}`
    );
  }
}

// Human-friendly chain aliases → numeric chain id, so a user never has to
// remember that Hyperliquid is 1337. Mirrors the trading-agent backend's
// parseChainId; the backend accepts these too, but the CLI also routes by chain
// internally (e.g. 1337 → Hyperliquid), so we normalize here as well.
const CHAIN_ALIASES: Record<string, number> = {
  ethereum: 1,
  eth: 1,
  mainnet: 1,
  base: 8453,
  "base-sepolia": 84532,
  basesepolia: 84532,
  arbitrum: 42161,
  arb: 42161,
  optimism: 10,
  op: 10,
  blast: 81457,
  scroll: 534352,
  linea: 59144,
  zora: 7777777,
  hyperliquid: 1337,
  hl: 1337,
  robinhood: 4663,
  polygon: 137,
  matic: 137,
  bnb: 56,
  bsc: 56,
};

// Resolve a chain reference (numeric id, numeric string, or named alias like
// "hyperliquid"/"arb") to its numeric id. Case-insensitive; throws on anything
// unrecognized.
export function parseChainArg(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new CliError(`Invalid chain: ${input}`, "VALIDATION_ERROR");
    }
    return input;
  }
  const t = String(input).trim();
  if (t === "") {
    throw new CliError("Chain is empty.", "VALIDATION_ERROR");
  }
  if (/^\d+$/.test(t)) {
    return Number(t);
  }
  const alias = CHAIN_ALIASES[t.toLowerCase()];
  if (alias === undefined) {
    throw new CliError(
      `Unknown chain "${input}".`,
      "VALIDATION_ERROR",
      `Use a numeric id or one of: ${Object.keys(CHAIN_ALIASES).join(", ")}.`
    );
  }
  return alias;
}
