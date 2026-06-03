// Treasures Finance — tokenized stock buy/sell via the public B2B API.
// Topologically this is just a swap (USDC ↔ ERC-20 stock token), so it slots
// into `acp trade` next to BondingV5/LiFi swaps and Hyperliquid orders.
//
// The CLI is still a thin signer here:
//   - sign the ownership-proof challenge so `/quote/*` will issue legs,
//   - sign each returned EIP-712 1inch Fusion order,
//   - POST the signed legs to `/trade/submit`,
//   - poll `/quote/{id}/status` until terminal.
// Private keys never leave the keystore — every signature comes from the same
// keystore-backed adapter the rest of `acp trade` uses.
//
// Solana legs are not signed by this module — the CLI keystore is EVM-only
// today, so a Sol-chain quote can be requested for inspection but cannot be
// submitted from here. EVM is the only first-cut path.

import { CliError } from "../errors";

const TREASURES_PROD_URL = "https://api.treasures.io/public/v1";
const TREASURES_STAGING_URL = "https://staging-api.treasures.io/public/v1";

// Resolve which Treasures host to hit. Mirrors how ACP_SERVER_URL switches
// on IS_TESTNET elsewhere in the CLI. An override lets ops point at a
// non-prod instance without rebuilding.
export function getTreasuresBaseUrl(): string {
  const override = process.env.TREASURES_API_URL;
  if (override) return override.replace(/\/$/, "");
  const isTestnet = process.env.IS_TESTNET === "true";
  return isTestnet ? TREASURES_STAGING_URL : TREASURES_PROD_URL;
}

// Canonical challenge: UTF-8, lines joined with "\n".
//   line 1: literal "treasures-finance-quote-v1"
//   line 2: issued_at (unix seconds, as decimal)
//   line 3: sol_wallet, or "" if absent
//   line 4: eth_wallet lowercased, or "" if absent
// "All-or-nothing per proof": if you signed with both wallets, every request
// that reuses that proof must include both wallets. A proof signed over
// {sol, eth} is not valid for an eth-only request — the empty-string line for
// the absent side differs, so the digest differs, and recovery fails.
export function buildChallenge(args: {
  issuedAt: number;
  solWallet?: string;
  ethWallet?: string;
}): string {
  return [
    "treasures-finance-quote-v1",
    String(args.issuedAt),
    args.solWallet ?? "",
    (args.ethWallet ?? "").toLowerCase(),
  ].join("\n");
}

// ───── Wire types (subset — only what the CLI actually consumes) ────────────

export type Chain = "sol" | "eth";
export type Protocol = "ondo" | "xstocks";

export interface OwnershipProof {
  eth_signature?: string;
  sol_signature?: string;
  issued_at: number;
}

export interface QuoteBuyRequest {
  ticker: string;
  amount_usdc: string;
  max_slippage_bps: number;
  chain?: Chain;
  protocol?: Protocol;
  sol_wallet?: string;
  eth_wallet?: string;
  ownership_proof: OwnershipProof;
}

export interface QuoteSellRequest {
  ticker: string;
  amount_shares: string;
  max_slippage_bps: number;
  chain?: Chain;
  protocol?: Protocol;
  sol_wallet?: string;
  eth_wallet?: string;
  ownership_proof: OwnershipProof;
}

export interface SignableEvmTypedData {
  type: "evm_eip712_typed_data";
  typed_data: {
    domain: { chainId: number; verifyingContract: string; name?: string; version?: string };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  };
}

export interface SignableSolanaTx {
  type: "solana_versioned_tx";
  tx_base64: string;
}

export type SignablePayload = SignableEvmTypedData | SignableSolanaTx;

export interface QuoteLeg {
  quote_index: number;
  chain: Chain;
  protocol: Protocol;
  price_usdc_per_share: string;
  // buy-only
  estimated_output_shares?: string;
  estimated_output_tokens?: string;
  // sell-only
  shares_consumed?: string;
  tokens_consumed?: string;
  estimated_output_usdc?: string;
  cost_breakdown_bps: {
    treasures_fee_bps: number;
    dex_swap_fee_bps: number;
    estimated_slippage_bps: number;
    slippage_vs_tradfi_bps?: number;
  };
  signable_payloads: SignablePayload[];
}

export interface QuoteResponse {
  quote_id: string;
  side: "buy" | "sell";
  ticker: string;
  expires_at: number;
  tradfi_reference: { price_usd: string; market_status: "open" | "closed"; as_of: number } | null;
  quotes: QuoteLeg[];
  totals?: { shares_total: string; usdc_total_estimated: string }; // sell only
}

export interface SignedEvmPayload {
  type: "evm_eip712_signature";
  signature: string;
}

export interface SignedSolanaPayload {
  type: "solana_versioned_tx";
  signed_tx_base64: string;
}

export type SignedPayload = SignedEvmPayload | SignedSolanaPayload;

export interface SignedLeg {
  quote_index: number;
  signed_payloads: SignedPayload[];
}

export interface TradeSubmitRequest {
  quote_id: string;
  signed: SignedLeg[];
}

export interface LegResult {
  quote_index: number;
  trade_id: string;
  status: "broadcast" | "broadcast_unknown" | "completed" | "failed" | "broadcast_failed";
  tx_hash: string | null;
  order_hash: string | null;
  error_code: string | null;
}

export interface TradeSubmitResponse {
  results: LegResult[];
  failed_legs: Array<{ quote_index: number; error_code: "internal_error" }>;
}

export type AggregateStatus = "in_progress" | "completed" | "partial_failed" | "all_failed";

export interface PublicLeg {
  quote_index: number;
  trade_id: string;
  ticker: string;
  chain: Chain;
  protocol: Protocol;
  side: "buy" | "sell";
  tx_hash: string | null;
  order_hash: string | null;
  status: "pending" | "completed" | "failed" | "broadcast_failed";
  error_code: string | null;
  filled_shares: string;
  filled_tokens: string;
  filled_usdc: string;
  last_synced_at: number;
}

export interface QuoteStatusResponse {
  quote_id: string;
  aggregate_status: AggregateStatus;
  is_cached: boolean;
  legs: PublicLeg[];
}

// ───── HTTP ─────────────────────────────────────────────────────────────────

// Same posture as the trade.ts proxy `post()`: refuse plaintext for any
// endpoint that returns calldata-to-sign or accepts signed actions. A
// downgraded hop could swap in a malicious order, and the keystore can't see
// what it's signing past raw bytes.
async function tfetch<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  const base = getTreasuresBaseUrl();
  if (!/^https:\/\//i.test(base)) {
    throw new CliError(
      `Refusing to call a non-https Treasures endpoint: ${base}`,
      "VALIDATION_ERROR",
      "Set TREASURES_API_URL to an https:// URL or unset it to use the default."
    );
  }
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // Read once as text so we can both surface non-JSON errors cleanly AND parse
  // the structured error bodies the API emits (e.g. {error, reason, message}).
  const raw = await res.text();
  if (!res.ok) {
    let parsed: { error?: string; reason?: string; message?: string } | string;
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      parsed = raw;
    }
    const detail =
      typeof parsed === "string"
        ? parsed
        : [parsed.error, parsed.reason, parsed.message].filter(Boolean).join(": ");
    throw new CliError(
      `Treasures ${method} ${path} → ${res.status}: ${detail || res.statusText}`,
      "API_ERROR"
    );
  }
  return JSON.parse(raw) as T;
}

export function quoteBuy(req: QuoteBuyRequest): Promise<QuoteResponse> {
  return tfetch<QuoteResponse>("POST", "/quote/buy", req);
}

export function quoteSell(req: QuoteSellRequest): Promise<QuoteResponse> {
  return tfetch<QuoteResponse>("POST", "/quote/sell", req);
}

export function tradeSubmit(req: TradeSubmitRequest): Promise<TradeSubmitResponse> {
  return tfetch<TradeSubmitResponse>("POST", "/trade/submit", req);
}

export function quoteStatus(quoteId: string): Promise<QuoteStatusResponse> {
  return tfetch<QuoteStatusResponse>("GET", `/quote/${encodeURIComponent(quoteId)}/status`);
}
