// Hyperliquid client wiring for the ACP CLI.
//
// HL is an off-chain order book on its own L1. Orders/cancels/withdrawals are
// not EVM transactions — they are EIP-712 typed-data actions POSTed to HL's API.
// We bridge the CLI's keystore-backed signer (Privy, secp256k1) into the HL SDK
// by presenting it as a viem-style local account: the SDK builds the typed data
// and calls `wallet.signTypedData(...)`, which we forward to the provider. The
// private key never leaves the OS keystore.
//
// The `chainId` we hand to `provider.signTypedData` only selects which configured
// signing client runs — the EIP-712 domain (carried inside the typed data, e.g.
// HL's L1 domain chainId 1337) is what actually gets hashed and signed, so it is
// preserved regardless of which client we route through.

import {
  ExchangeClient,
  HttpTransport,
  InfoClient,
} from "@nktkas/hyperliquid";
import type { Address } from "viem";
import { createProviderAdapter, getWalletAddress } from "../agentFactory";
import { CliError } from "../errors";

export function isTestnet(): boolean {
  return process.env.IS_TESTNET === "true";
}

// Base (mainnet) / Base Sepolia (testnet) — the only chains the default ACP
// provider has a signing client for. Used purely as a signing-client selector.
const SIGNING_CHAIN_ID_MAINNET = 8453;
const SIGNING_CHAIN_ID_TESTNET = 84532;

export interface HlClients {
  info: InfoClient;
  exchange: ExchangeClient;
  address: Address;
}

interface ViemTypedDataParams {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export async function createHlClients(): Promise<HlClients> {
  const testnet = isTestnet();
  const provider = await createProviderAdapter();
  const address = getWalletAddress() as Address;
  const signingChainId = testnet
    ? SIGNING_CHAIN_ID_TESTNET
    : SIGNING_CHAIN_ID_MAINNET;

  // Shaped as the SDK's AbstractViemLocalAccount: { address, signTypedData }.
  const wallet = {
    address,
    signTypedData: (params: ViemTypedDataParams): Promise<`0x${string}`> =>
      provider.signTypedData(signingChainId, params) as Promise<`0x${string}`>,
  };

  const transport = new HttpTransport({ isTestnet: testnet });
  return {
    info: new InfoClient({ transport }),
    exchange: new ExchangeClient({ transport, wallet }),
    address,
  };
}

export function createHlInfoClient(): InfoClient {
  return new InfoClient({ transport: new HttpTransport({ isTestnet: isTestnet() }) });
}

// ---------- Asset resolution ----------

export interface ResolvedAsset {
  /** HL asset index used as the `a` field in an order. */
  assetIndex: number;
  /** Size decimals for rounding the order quantity. */
  szDecimals: number;
  /** Canonical coin label as HL knows it. */
  name: string;
  /**
   * Key to look this asset up in `allMids()`. Perps use the coin name; spot
   * pairs are keyed `@{pairIndex}` (with `PURR/USDC` the historical exception
   * exposed as `PURR`). Using `name` for spot returns no mid and breaks
   * market orders.
   */
  midKey: string;
}

export async function resolvePerpAsset(
  info: InfoClient,
  coin: string
): Promise<ResolvedAsset> {
  const meta = await info.meta();
  const idx = meta.universe.findIndex(
    (u) => u.name.toUpperCase() === coin.toUpperCase()
  );
  if (idx === -1) {
    throw new CliError(
      `Unknown perp coin: ${coin}`,
      "VALIDATION_ERROR",
      "Use the perp symbol as listed on Hyperliquid (e.g. BTC, ETH, SOL)."
    );
  }
  return {
    assetIndex: idx,
    szDecimals: meta.universe[idx].szDecimals,
    name: meta.universe[idx].name,
    midKey: meta.universe[idx].name, // perps: allMids keyed by coin name
  };
}

export async function resolveSpotAsset(
  info: InfoClient,
  coin: string
): Promise<ResolvedAsset> {
  const sm = await info.spotMeta();
  // Match by base-token name against USDC-quoted pairs (quote token index 0).
  const token = sm.tokens.find(
    (t) => t.name.toUpperCase() === coin.toUpperCase()
  );
  if (!token) {
    throw new CliError(
      `Unknown spot token: ${coin}`,
      "VALIDATION_ERROR",
      "Use a token symbol listed on the Hyperliquid spot order book (e.g. PURR)."
    );
  }
  const pair = sm.universe.find(
    (p) => p.tokens[0] === token.index && p.tokens[1] === 0
  );
  if (!pair) {
    throw new CliError(
      `No USDC spot pair for token: ${coin}`,
      "VALIDATION_ERROR",
      "Only USDC-quoted spot pairs are supported by `acp hl spot`."
    );
  }
  return {
    // Spot order asset index is 10000 + the spot pair index.
    assetIndex: 10000 + pair.index,
    szDecimals: token.szDecimals,
    name: pair.name,
    // allMids keys spot pairs by `@{pairIndex}`; PURR/USDC is the exception
    // historically exposed as `PURR`.
    midKey: pair.name === "PURR/USDC" ? "PURR" : `@${pair.index}`,
  };
}

// ---------- Price / size formatting ----------
//
// HL rejects orders whose price has > 5 significant figures or too many
// decimals. Max price decimals = (isSpot ? 8 : 6) - szDecimals. Integer prices
// are always allowed. Sizes are rounded to the asset's szDecimals.

export function formatSize(value: number, szDecimals: number): string {
  return trimZeros(value.toFixed(szDecimals));
}

export function formatPrice(
  value: number,
  szDecimals: number,
  isSpot: boolean
): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError(`Invalid price: ${value}`, "VALIDATION_ERROR");
  }
  const maxDecimals = (isSpot ? 8 : 6) - szDecimals;
  // 5 significant figures, then clamp to the decimal cap.
  let px = Number(value.toPrecision(5));
  const factor = Math.pow(10, Math.max(maxDecimals, 0));
  px = Math.round(px * factor) / factor;
  return trimZeros(px.toFixed(Math.max(maxDecimals, 0)));
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * Aggressive limit price for a market (IOC) order: cross the mid by `slippage`
 * (fraction, e.g. 0.05 = 5%) so the order fills immediately.
 */
export async function marketPrice(
  info: InfoClient,
  midKey: string,
  isBuy: boolean,
  szDecimals: number,
  isSpot: boolean,
  slippage: number
): Promise<string> {
  const mids = await info.allMids();
  const raw = mids[midKey];
  if (raw === undefined) {
    throw new CliError(
      `No mid price available for ${midKey}`,
      "API_ERROR",
      "Pass an explicit --price to place a limit order instead."
    );
  }
  const mid = Number(raw);
  const crossed = isBuy ? mid * (1 + slippage) : mid * (1 - slippage);
  return formatPrice(crossed, szDecimals, isSpot);
}
