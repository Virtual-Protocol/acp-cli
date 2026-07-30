// `acp swap` -- gasless cross-chain swaps via Geodesics (docs.geodesics.ai).
// Complements `acp trade` with a different execution model: the Geodesics API
// quotes and builds the whole route server-side, the wallet key signs ONE
// payload (a 32-byte operation hash via EIP-191 for EVM origins, the whole
// prebuilt transaction for Solana origins), the server submits, and the CLI
// polls to settlement. Cross-chain swaps are gasless on every origin -- the
// wallet needs no native gas token and no fee float on any chain, Solana
// included -- and the first swap from an EVM chain the wallet has never used
// onboards it inside that same swap (a one-time EIP-7702 delegation
// authorization signed through the wallet's signer service; no separate
// activation transaction).
//
// The one exception is a SAME-CHAIN Solana swap, which needs a little SOL
// (~0.005) for network fees. A swap that lacks it fails fast with the
// server's typed refusal; --confirm-pipe approves funding it in-line by
// piping ~1.5 of a basis-chain stable (Base USDC or Robinhood Chain USDG,
// whichever the wallet holds) into SOL, then retrying.
//
// Flag vocabulary mirrors `acp trade` (--token-in/--chain-in/--amount-in/
// --token-out/--chain-out/--recipient/--slippage/--dry-run). Tokens are
// addresses first, plus one convenience: canonical symbols (usdc, usdt, usdg,
// weth, virtual, eth, pol, matic, bnb, sol) resolve client-side through the
// SDK's published chain-scoped alias table. Resolution is exact or an error --
// a symbol the chain does not have never remaps to another token or chain,
// and the resolved address is echoed in the output, so what gets quoted is
// always explicit. --amount-in is human units (decimals from the alias table,
// else read on-chain), or "max" for the wallet's full balance.
//
// Quotes carry the venue-priced USD value of both sides and the all-in value
// change in basis points (negative = the output is worth less). A quote the
// server flags with its high-price-impact warning is refused unless
// --accept-impact is passed; --dry-run always just shows the numbers.
//
// Env: GEODESICS_API_KEY (required -- free key at console.geodesics.ai);
// GEODESICS_API_URL (optional override, https-only like the trade endpoint).
// Everything else -- wallet, signer, auth -- is the standard `acp configure` +
// `acp agent add-signer` setup shared with every other signing command.

import type { Command } from "commander";
import type { Address } from "viem";
import { formatUnits, getAddress, isAddress, isHex, parseUnits } from "viem";
import {
  CHAIN_IDS,
  createGeodesicsClient,
  GeodesicsApiError,
  type GeodesicsClient,
  GeodesicsTimeoutError,
  type QuoteRequest,
  type QuoteResponse,
  type ResolvedTokenAlias,
  resolveTokenAlias,
  type SignedAuthorization,
  type SupportedChainId,
  type SwapProgress,
  type SwapSigner,
  tokenAliasesForChain,
} from "@geodesics-protocol/sdk";
import { address as solanaAddress } from "@solana/kit";
import {
  getSplTokenBalance,
  type IEvmProviderAdapter,
  type ISolanaProviderAdapter,
} from "@virtuals-protocol/acp-node-v2";
import { isJson, isTTY, outputError, outputResult } from "../lib/output";
import { CliError, type ErrorCode } from "../lib/errors";
import { parseChainArg } from "../lib/chains";
import {
  createProviderAdapter,
  createSolanaProviderAdapter,
  getSolanaWalletAddress,
  getWalletAddress,
} from "../lib/agentFactory";
import { withApprovalGate } from "../lib/walletGate";

const GEODESICS_API_URL = "https://api.geodesics.ai";
const SIGNING_CHAIN_ID = CHAIN_IDS.base;
const SOLANA_MAINNET_PRIVY_CHAIN_ID = 501;
const SOL_TOPUP_STABLE_UNITS = "1.5";

const SUPPORTED_CHAIN_IDS: ReadonlySet<number> = new Set(
  Object.values(CHAIN_IDS)
);

function isSupportedChain(chainId: number): chainId is SupportedChainId {
  return SUPPORTED_CHAIN_IDS.has(chainId);
}

function supportedChainSummary(): string {
  return Object.entries(CHAIN_IDS)
    .map(([name, id]) => `${name} (${id})`)
    .join(", ");
}

// ---------- Command registration ----------

export function registerSwapCommands(program: Command): void {
  program
    .command("swap")
    .description(
      "Gasless cross-chain swap via Geodesics: sign one hash, receive the " +
      "output token on the destination chain in seconds. Costs come out of " +
      "the input -- no gas token or fee float needed on any chain. " +
      "Tokens: contract addresses, or canonical symbols like usdc/usdg/weth. " +
      "See `acp swap --help`."
    )
    .addHelpText(
      "after",
      "\nSupported chains (pass the id or the name): Ethereum (1), Base (8453), Arbitrum (42161),\n" +
      "  Optimism (10), Polygon (137), BNB (56), Robinhood Chain (4663 / robinhood), Solana (sol).\n" +
      "\nTokens: pass a contract address (always works), or a canonical symbol -- usdc, usdt,\n" +
      "usdg, weth, virtual, eth, pol, matic, bnb, sol -- resolved client-side per chain.\n" +
      "A symbol the chain does not have is an error, never a substitution, and the resolved\n" +
      "address is echoed in the output: what you pass is exactly what gets quoted.\n" +
      "--amount-in is in human units, or 'max' for the full balance.\n" +
      "\nEvery quote reports the USD value of both sides and the all-in value change in\n" +
      "basis points (negative = the output is worth less). A swap the server flags for\n" +
      "high price impact is refused unless --accept-impact is passed.\n" +
      "\nFirst swap from a new EVM chain: the wallet is onboarded inside the swap itself,\n" +
      "gasless -- no prior balance or activation needed on that chain.\n" +
      "\nSolana works both ways, gasless like everywhere else. As the destination, the\n" +
      "output is delivered to the agent's Solana wallet (or --recipient). As the ORIGIN\n" +
      "(inputs: sol, usdc, usdt), the agent's Solana wallet signs the prebuilt transaction\n" +
      "and needs no SOL at all for cross-chain swaps. Only a SAME-CHAIN Solana swap needs\n" +
      "a little SOL (~0.005) for fees -- pass --confirm-pipe to fund that automatically.\n" +
      "\nExamples:\n" +
      "  # 5 USDC on Base -> USDG on Robinhood Chain (canonical symbols)\n" +
      "  acp swap --token-in usdc --chain-in base --amount-in 5 --token-out usdg --chain-out robinhood --json\n" +
      "  # The same swap with explicit addresses (any ERC-20 works by address)\n" +
      "  acp swap --token-in 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --chain-in base --amount-in 5 \\\n" +
      "    --token-out 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 --chain-out robinhood --json\n" +
      "  # Preview only: route, fee, USD in/out, price impact -- nothing signed\n" +
      "  acp swap --token-in usdc --chain-in base --amount-in 5 --token-out usdg --chain-out 4663 --dry-run --json\n" +
      "  # Swap the wallet's ENTIRE balance back (the safe way to return a delivery)\n" +
      "  acp swap --token-in usdg --chain-in robinhood --amount-in max --token-out usdc --chain-out base --json\n" +
      "  # Solana-origin: swap the agent's Solana USDC to USDG on Robinhood Chain, no SOL needed\n" +
      "  acp swap --token-in usdc --chain-in sol --amount-in 2 --token-out usdg --chain-out robinhood --json\n"
    )
    .requiredOption(
      "--token-in <token>",
      "Input token: contract address on the origin chain, or a canonical symbol (e.g. usdc)"
    )
    .requiredOption(
      "--chain-in <id>",
      "Origin chain id or name (e.g. 8453, base, robinhood)"
    )
    .requiredOption(
      "--amount-in <amount>",
      "Input amount in human units, or 'max' for the wallet's full balance"
    )
    .requiredOption(
      "--token-out <token>",
      "Output token on the destination chain: address, native/SPL id, or a canonical symbol"
    )
    .requiredOption(
      "--chain-out <id>",
      "Destination chain id or name (e.g. 4663, robinhood, sol)"
    )
    .option(
      "--recipient <addr>",
      "Output recipient (default: the agent's wallet on the destination chain, its Solana wallet for a Solana destination)"
    )
    .option(
      "--slippage <pct>",
      "Max slippage as a percent, e.g. 1 = 1% (server default per route if omitted)"
    )
    .option(
      "--dry-run",
      "Quote only: route, fee, USD value both sides, price impact -- nothing signed or submitted",
      false
    )
    .option(
      "--accept-impact",
      "Execute even when the quote carries the server's high-price-impact warning",
      false
    )
    .option(
      "--confirm-pipe",
      "If a same-chain Solana swap needs SOL for fees, approve piping ~1.5 of a basis-chain stable into SOL first",
      false
    )
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        await runSwap(opts, json);
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}

// ---------- Swap flow ----------

async function runSwap(
  opts: Record<string, unknown>,
  json: boolean
): Promise<void> {
  if (process.env.IS_TESTNET === "true") {
    throw new CliError(
      "`acp swap` supports mainnet only.",
      "VALIDATION_ERROR",
      "Unset IS_TESTNET to swap."
    );
  }
  const originChain = resolveSwapChain(opts.chainIn);
  const destinationChain = resolveSwapChain(opts.chainOut);
  const originIsSolana = originChain === CHAIN_IDS.solana;
  const outputToken = resolveOutputToken(
    String(opts.tokenOut),
    destinationChain
  );
  const slippageBps = resolveSlippageBps(opts.slippage);

  const geodesics = createGeodesicsClient({
    baseUrl: resolveGeodesicsUrl(),
    apiKey: requireGeodesicsApiKey(),
  });
  const evmWalletAddress = parseEvmAddress(
    getWalletAddress(),
    "the active agent wallet"
  );
  const recipient = await resolveRecipientWithDefaults(
    opts.recipient,
    originIsSolana,
    destinationChain,
    evmWalletAddress
  );

  const provider = await createProviderAdapter();

  let request: QuoteRequest;
  let evmPreflight:
    | { token: Address; amount: bigint; decimals: number }
    | undefined;
  let solanaPreflight:
    | { token: string; amount: bigint; decimals: number }
    | undefined;
  if (originIsSolana) {
    const input = resolveSolanaInputToken(String(opts.tokenIn));
    const amount = resolveSolanaInputAmount(
      String(opts.amountIn),
      input.decimals
    );
    const solanaWalletAddress = await getSolanaWalletAddress();
    request = {
      originChain,
      destinationChain,
      inputToken: input.token,
      outputToken,
      amount,
      walletAddress: solanaWalletAddress,
      ...(recipient !== undefined ? { recipient } : {}),
      ...(slippageBps !== undefined ? { slippageBps } : {}),
    };
    solanaPreflight = {
      token: input.token,
      amount: BigInt(amount),
      decimals: input.decimals,
    };
  } else {
    const input = resolveInputToken(String(opts.tokenIn), originChain);
    const decimals =
      input.decimals ??
      (await readTokenDecimals(provider, originChain, input.address));
    const amount = await resolveInputAmount(
      provider,
      originChain,
      input.address,
      evmWalletAddress,
      String(opts.amountIn),
      decimals
    );
    request = {
      originChain,
      destinationChain,
      inputToken: input.address,
      outputToken,
      amount,
      walletAddress: evmWalletAddress,
      ...(recipient !== undefined ? { recipient } : {}),
      ...(slippageBps !== undefined ? { slippageBps } : {}),
    };
    evmPreflight = { token: input.address, amount: BigInt(amount), decimals };
  }

  if (opts.dryRun) {
    const quote = await runGeodesics(() => geodesics.quote(request));
    outputResult(json, {
      dryRun: true,
      inputToken: request.inputToken,
      outputToken: request.outputToken,
      output: quote.output,
      feeBps: quote.feeBps,
      ...(quote.inputUsd !== undefined ? { inputUsd: quote.inputUsd } : {}),
      ...(quote.outputUsd !== undefined ? { outputUsd: quote.outputUsd } : {}),
      ...(quote.priceImpactBps !== undefined
        ? { priceImpactBps: quote.priceImpactBps }
        : {}),
      expiresAt: quote.expiresAt,
      originChain,
      destinationChain,
      ...(quote.warnings && quote.warnings.length > 0
        ? { warnings: quote.warnings.map((warning) => warning.message) }
        : {}),
    });
    return;
  }

  if (evmPreflight !== undefined) {
    await assertSufficientBalance(
      provider,
      originChain,
      evmPreflight.token,
      evmWalletAddress,
      evmPreflight.amount,
      evmPreflight.decimals,
      json
    );
  }

  if (!originIsSolana) {
    const preflight = await runGeodesics(() => geodesics.quote(request));
    assertImpactAccepted(preflight, Boolean(opts.acceptImpact));
    reportQuotedImpact(json, preflight);
  }

  let solanaSigner: SwapSigner | undefined;
  if (originIsSolana) {
    const solanaProvider = await createSolanaProviderAdapter(
      SOLANA_MAINNET_PRIVY_CHAIN_ID
    );
    if (solanaPreflight !== undefined) {
      await assertSufficientSolanaBalance(
        solanaBalanceReads(solanaProvider),
        request.walletAddress,
        solanaPreflight.token,
        solanaPreflight.amount,
        solanaPreflight.decimals,
        json
      );
    }
    solanaSigner = createGeodesicsSolanaSwapSigner(solanaProvider);
  }
  const result = await withApprovalGate(
    async (gatedProvider) => {
      if (solanaSigner === undefined) {
        return executeSwap(
          geodesics,
          createGeodesicsSwapSigner(gatedProvider),
          request,
          json
        );
      }
      const preflight = await preflightSolanaQuote(
        geodesics,
        gatedProvider,
        request,
        Boolean(opts.confirmPipe),
        evmWalletAddress,
        json
      );
      assertImpactAccepted(preflight, Boolean(opts.acceptImpact));
      reportQuotedImpact(json, preflight);
      return executeSwap(geodesics, solanaSigner, request, json);
    },
    { json, deferSocket: true, evmProvider: Promise.resolve(provider) }
  );
  outputResult(json, result);
}

function reportQuotedImpact(json: boolean, quote: QuoteResponse): void {
  if (quote.priceImpactBps === undefined) return;
  progress(
    json,
    `Quoted value change ${(quote.priceImpactBps / 100).toFixed(2)}% (price impact + network costs + fee)`
  );
}

export async function executeSwap(
  client: GeodesicsClient,
  signer: SwapSigner,
  request: QuoteRequest,
  json: boolean
): Promise<Record<string, unknown>> {
  const result = await runGeodesics(() =>
    client.swap(request, signer, {
      onProgress: (p) => progress(json, describeProgress(p)),
    })
  );
  return {
    swapId: result.swapId,
    status: result.status,
    output: result.output,
    feeBps: result.feeBps,
    ...(result.priceImpactBps !== undefined
      ? { priceImpactBps: result.priceImpactBps }
      : {}),
    ...(result.originTxHash ? { originTxHash: result.originTxHash } : {}),
    ...(result.deliveryTxHash ? { deliveryTxHash: result.deliveryTxHash } : {}),
    ...(result.refundHint ? { refundHint: result.refundHint } : {}),
    ...(result.warnings && result.warnings.length > 0
      ? { warnings: [...result.warnings] }
      : {}),
  };
}

// ---------- Signer bridge ----------

type DelegationAuthorizationRequest = {
  chainId: number;
  address: string;
  nonce: number;
};

type SignAuthorizationViaService = (request: {
  contractAddress: string;
  chainId: number;
  nonce: number;
}) => Promise<unknown>;

function getAuthorizationSigner(
  provider: IEvmProviderAdapter
): SignAuthorizationViaService | undefined {
  const signer: unknown = Reflect.get(provider, "signer");
  if (signer === null || typeof signer !== "object") return undefined;
  const method: unknown = Reflect.get(signer, "signAuthorization");
  if (typeof method !== "function") return undefined;
  return (request) => Promise.resolve(method.call(signer, request));
}

async function signDelegationAuthorization(
  signAuthorizationViaService: SignAuthorizationViaService,
  request: DelegationAuthorizationRequest
): Promise<SignedAuthorization> {
  const rawAuthorization = await signAuthorizationViaService({
    contractAddress: request.address,
    chainId: request.chainId,
    nonce: request.nonce,
  });
  if (rawAuthorization === null || typeof rawAuthorization !== "object") {
    throw new CliError(
      "The signer service returned no authorization object.",
      "API_ERROR"
    );
  }
  const echoedAddress: unknown = Reflect.get(rawAuthorization, "address");
  if (
    typeof echoedAddress === "string" &&
    echoedAddress.toLowerCase() !== request.address.toLowerCase()
  ) {
    throw new CliError(
      `Signer authorized a different delegation target: expected ${request.address}, got ${echoedAddress}`,
      "API_ERROR"
    );
  }
  return {
    chainId: request.chainId,
    address: parseEvmAddress(request.address, "the delegation target"),
    nonce: request.nonce,
    yParity: normalizeYParity(Reflect.get(rawAuthorization, "yParity")),
    r: ensureHex(Reflect.get(rawAuthorization, "r"), "r"),
    s: ensureHex(Reflect.get(rawAuthorization, "s"), "s"),
  };
}

export function createGeodesicsSwapSigner(
  provider: IEvmProviderAdapter
): SwapSigner {
  const signAuthorizationViaService = getAuthorizationSigner(provider);
  return {
    signMessage: (geoOpHash: string) =>
      provider.signMessage(SIGNING_CHAIN_ID, geoOpHash),

    sendTransaction: async (
      chainId: number,
      call: { to: string; data: string }
    ) =>
      provider.sendTransaction(chainId, {
        to: parseEvmAddress(call.to, "the transaction target"),
        data: ensureHex(call.data, "calldata"),
      }),

    ...(signAuthorizationViaService
      ? {
        signAuthorization: (request: DelegationAuthorizationRequest) =>
          signDelegationAuthorization(signAuthorizationViaService, request),
      }
      : {}),
  };
}

function getSolanaTransactionSigner(
  provider: ISolanaProviderAdapter
): ((unsignedTransactionBase64: string) => Promise<string>) | undefined {
  const method: unknown = Reflect.get(provider, "signTransactionViaPrivy");
  if (typeof method !== "function") return undefined;
  return async (unsignedTransactionBase64: string) => {
    const signedTransaction: unknown = await method.call(
      provider,
      unsignedTransactionBase64
    );
    if (typeof signedTransaction !== "string" || signedTransaction.length === 0) {
      throw new CliError(
        "The Solana signer service returned no signed transaction.",
        "API_ERROR"
      );
    }
    return signedTransaction;
  };
}

export function createGeodesicsSolanaSwapSigner(
  provider: ISolanaProviderAdapter
): SwapSigner {
  const signTransactionViaService = getSolanaTransactionSigner(provider);
  if (signTransactionViaService === undefined) {
    throw new CliError(
      "The agent's Solana signer service does not expose transaction signing.",
      "NO_SIGNER",
      "Update @virtuals-protocol/acp-node-v2; its Privy Solana adapter provides it."
    );
  }
  return { signSolanaTransaction: signTransactionViaService };
}

function normalizeYParity(value: unknown): 0 | 1 {
  if (value === 0 || value === "0" || value === "0x0") return 0;
  if (value === 1 || value === "1" || value === "0x1") return 1;
  throw new CliError(
    `Signer returned an unrecognized authorization yParity: ${String(value)}`,
    "API_ERROR"
  );
}

function ensureHex(value: unknown, label: string): `0x${string}` {
  const candidate =
    typeof value === "string" && !value.startsWith("0x") ? `0x${value}` : value;
  if (
    typeof candidate !== "string" ||
    !isHex(candidate, { strict: true }) ||
    candidate.length % 2 !== 0
  ) {
    throw new CliError(
      `Signer returned a non-hex authorization ${label}.`,
      "API_ERROR"
    );
  }
  return candidate;
}

// ---------- Token resolution ----------

const EVM_NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

function describeChain(chainId: number): string {
  const entry = Object.entries(CHAIN_IDS).find(([, id]) => id === chainId);
  return entry ? entry[0] : `chain ${chainId}`;
}

function describeToken(chainId: SupportedChainId, tokenAddress: string): string {
  const aliasNames: readonly string[] = tokenAliasesForChain(chainId);
  for (const aliasName of aliasNames) {
    const alias: ResolvedTokenAlias | undefined = resolveTokenAlias(
      chainId,
      aliasName
    );
    if (alias === undefined) continue;
    const candidate = String(alias.address);
    const matches =
      candidate === tokenAddress ||
      (tokenAddress.startsWith("0x") &&
        candidate.toLowerCase() === tokenAddress.toLowerCase());
    if (matches) {
      return aliasName.toUpperCase();
    }
  }
  return tokenAddress;
}

function knownSymbolsHint(chainId: SupportedChainId): string {
  const symbols: readonly string[] = tokenAliasesForChain(chainId);
  return symbols.length > 0
    ? `Symbols known on this chain: ${symbols.join(", ")}. Any token contract address also works.`
    : "This chain has no known symbols; pass the token's contract address.";
}

function validAliasDecimals(value: unknown): number {
  const decimals = Number(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new CliError(
      `The token alias table returned unexpected decimals: ${String(value)}.`,
      "API_ERROR"
    );
  }
  return decimals;
}

export function resolveInputToken(
  tokenRef: string,
  originChain: SupportedChainId
): { address: Address; decimals?: number } {
  const alias: ResolvedTokenAlias | undefined = resolveTokenAlias(
    originChain,
    tokenRef
  );
  if (alias !== undefined) {
    if (alias.address === EVM_NATIVE_ADDRESS) {
      throw new CliError(
        `--token-in ${tokenRef}: the chain's native gas token cannot be the swap input yet.`,
        "VALIDATION_ERROR",
        "Swap an ERC-20 instead (e.g. a stable or the wrapped token); the native token IS supported as --token-out."
      );
    }
    return {
      address: parseEvmAddress(String(alias.address), "--token-in"),
      decimals: validAliasDecimals(alias.decimals),
    };
  }
  return {
    address: parseEvmAddress(tokenRef, "--token-in", knownSymbolsHint(originChain)),
  };
}

export function resolveOutputToken(
  tokenRef: string,
  destinationChain: SupportedChainId
): string {
  const alias: ResolvedTokenAlias | undefined = resolveTokenAlias(
    destinationChain,
    tokenRef
  );
  if (alias !== undefined) return String(alias.address);
  if (destinationChain === CHAIN_IDS.solana) {
    if (!SOLANA_ADDRESS_PATTERN.test(tokenRef.trim())) {
      throw new CliError(
        `--token-out is not a valid Solana token for this destination: "${tokenRef}".`,
        "VALIDATION_ERROR",
        knownSymbolsHint(destinationChain)
      );
    }
    return tokenRef.trim();
  }
  return parseEvmAddress(
    tokenRef,
    "--token-out",
    knownSymbolsHint(destinationChain)
  );
}

export function resolveSolanaInputToken(tokenRef: string): {
  token: string;
  decimals: number;
} {
  const alias: ResolvedTokenAlias | undefined = resolveTokenAlias(
    CHAIN_IDS.solana,
    tokenRef
  );
  if (alias === undefined) {
    const supported: readonly string[] = tokenAliasesForChain(CHAIN_IDS.solana);
    throw new CliError(
      `--token-in is not a supported Solana-origin input: "${tokenRef}".`,
      "VALIDATION_ERROR",
      `Solana-origin inputs: ${supported.join(", ")} (raw mint addresses are not resolved yet).`
    );
  }
  return {
    token: String(alias.address),
    decimals: validAliasDecimals(alias.decimals),
  };
}

// ---------- Price impact gate ----------

export function assertImpactAccepted(
  quote: QuoteResponse,
  acceptImpact: boolean
): void {
  const highImpact = quote.warnings?.find(
    (warning) => warning.code === "HIGH_PRICE_IMPACT"
  );
  if (highImpact === undefined || acceptImpact) return;
  throw new CliError(highImpact.message, "PRICE_IMPACT_HIGH",
    "Re-run with --accept-impact to execute anyway, or adjust --amount-in: tiny swaps lose mostly to fixed costs."
  );
}

// ---------- Input validation ----------

function resolveSwapChain(input: unknown): SupportedChainId {
  const raw = String(input).trim().toLowerCase();
  const chainId =
    raw === "sol" || raw === "solana"
      ? CHAIN_IDS.solana
      : parseChainArg(String(input));
  if (!isSupportedChain(chainId)) {
    throw new CliError(
      `Chain "${String(input)}" is not supported by Geodesics.`,
      "VALIDATION_ERROR",
      `Supported chains: ${supportedChainSummary()}.`
    );
  }
  return chainId;
}

function parseEvmAddress(
  candidate: string,
  label: string,
  recovery?: string
): Address {
  if (!isAddress(candidate, { strict: false })) {
    throw new CliError(
      `${label} is not a valid EVM address: "${candidate}".`,
      "VALIDATION_ERROR",
      recovery
    );
  }
  return getAddress(candidate);
}

const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function resolveRecipientWithDefaults(
  recipientOption: unknown,
  originIsSolana: boolean,
  destinationChain: SupportedChainId,
  evmWalletAddress: Address
): Promise<string | undefined> {
  if (destinationChain === CHAIN_IDS.solana) {
    if (recipientOption !== undefined) {
      const candidate = String(recipientOption).trim();
      if (!SOLANA_ADDRESS_PATTERN.test(candidate)) {
        throw new CliError(
          `--recipient is not a valid Solana address: "${candidate}".`,
          "VALIDATION_ERROR",
          "A Solana destination needs a base58 recipient address."
        );
      }
      return candidate;
    }
    try {
      return await getSolanaWalletAddress();
    } catch (err) {
      if (err instanceof CliError && err.code === "NO_SOLANA_WALLET") {
        throw new CliError(
          "--recipient is required for a Solana destination (this agent has no Solana wallet).",
          "VALIDATION_ERROR",
          "Pass the receiving base58 Solana address."
        );
      }
      throw err;
    }
  }
  if (recipientOption !== undefined) {
    return parseEvmAddress(String(recipientOption), "--recipient");
  }
  return originIsSolana ? evmWalletAddress : undefined;
}

function resolveSlippageBps(slippageOption: unknown): number | undefined {
  if (slippageOption === undefined) return undefined;
  const percent = Number(slippageOption);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 50) {
    throw new CliError(
      `--slippage must be a percent between 0 (exclusive) and 50, got "${String(slippageOption)}".`,
      "VALIDATION_ERROR",
      "Example: --slippage 1 = 1% max slippage."
    );
  }
  return Math.round(percent * 100);
}

function requireGeodesicsApiKey(): string {
  const key = process.env.GEODESICS_API_KEY;
  if (!key) {
    throw new CliError(
      "GEODESICS_API_KEY is not set.",
      "VALIDATION_ERROR",
      "Get a free API key at https://console.geodesics.ai and export GEODESICS_API_KEY."
    );
  }
  return key;
}

function resolveGeodesicsUrl(): string {
  const override = process.env.GEODESICS_API_URL?.trim();
  const base = (override || GEODESICS_API_URL).replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new CliError(
      `GEODESICS_API_URL is not a valid URL: ${base}`,
      "VALIDATION_ERROR",
      "The Geodesics API base URL must be https:// (http allowed only for localhost)."
    );
  }
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new CliError(
      `Refusing to call a non-https Geodesics endpoint: ${base}`,
      "VALIDATION_ERROR",
      "The Geodesics API base URL must be https:// (http allowed only for localhost)."
    );
  }
  return base;
}

// ---------- On-chain reads ----------

const ERC20_READS_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

async function readTokenDecimals(
  provider: IEvmProviderAdapter,
  chainId: number,
  token: Address
): Promise<number> {
  try {
    const raw = await provider.readContract(chainId, {
      address: token,
      abi: ERC20_READS_ABI,
      functionName: "decimals",
    });
    const decimals = Number(raw);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error(`unexpected decimals value: ${String(raw)}`);
    }
    return decimals;
  } catch (err) {
    throw new CliError(
      `Could not read decimals for ${token} on ${describeChain(chainId)}: ${err instanceof Error ? err.message : String(err)}`,
      "VALIDATION_ERROR",
      "Check that --token-in is an ERC-20 contract address on --chain-in."
    );
  }
}

async function readTokenBalance(
  provider: IEvmProviderAdapter,
  chainId: number,
  token: Address,
  walletAddress: Address
): Promise<bigint> {
  const raw = await provider.readContract(chainId, {
    address: token,
    abi: ERC20_READS_ABI,
    functionName: "balanceOf",
    args: [walletAddress],
  });
  return BigInt(String(raw));
}

function parseExplicitAmount(amountIn: string, decimals: number): string {
  let parsed: bigint;
  try {
    parsed = parseUnits(amountIn, decimals);
  } catch {
    throw new CliError(
      `--amount-in is not a valid decimal amount: "${amountIn}".`,
      "VALIDATION_ERROR",
      "Pass a positive number in human units (e.g. 5 or 0.25)."
    );
  }
  if (parsed <= 0n) {
    throw new CliError(
      `--amount-in must be positive, got "${amountIn}".`,
      "VALIDATION_ERROR",
      "Pass a positive number in human units (e.g. 5 or 0.25)."
    );
  }
  return parsed.toString();
}

function resolveSolanaInputAmount(amountIn: string, decimals: number): string {
  if (amountIn.trim().toLowerCase() === "max") {
    throw new CliError(
      "--amount-in max is not supported for a Solana origin yet.",
      "VALIDATION_ERROR",
      "Pass an explicit amount in human units (e.g. 2 or 0.25)."
    );
  }
  return parseExplicitAmount(amountIn, decimals);
}

async function resolveInputAmount(
  provider: IEvmProviderAdapter,
  chainId: SupportedChainId,
  token: Address,
  walletAddress: Address,
  amountIn: string,
  decimals: number
): Promise<string> {
  if (amountIn.trim().toLowerCase() !== "max") {
    return parseExplicitAmount(amountIn, decimals);
  }
  let balance: bigint;
  try {
    balance = await readTokenBalance(provider, chainId, token, walletAddress);
  } catch (err) {
    throw new CliError(
      `Could not read the wallet's ${describeToken(chainId, token)} balance on ${describeChain(chainId)}: ${err instanceof Error ? err.message : String(err)}`,
      "API_ERROR",
      "Retry, or pass an explicit --amount-in."
    );
  }
  if (balance === 0n) {
    throw new CliError(
      `--amount-in max: the wallet holds no ${describeToken(chainId, token)} on ${describeChain(chainId)}.`,
      "INSUFFICIENT_BALANCE",
      "Fund the wallet or check --token-in/--chain-in."
    );
  }
  return balance.toString();
}

async function assertSufficientBalance(
  provider: IEvmProviderAdapter,
  chainId: SupportedChainId,
  token: Address,
  walletAddress: Address,
  amount: bigint,
  decimals: number,
  json: boolean
): Promise<void> {
  let balance: bigint;
  try {
    balance = await readTokenBalance(provider, chainId, token, walletAddress);
  } catch (err) {
    progress(
      json,
      `Warning: could not read the origin balance for the preflight check (${err instanceof Error ? err.message : String(err)}); continuing.`
    );
    return;
  }
  if (balance < amount) {
    throw new CliError(
      `The wallet holds ${formatUnits(balance, decimals)} ${describeToken(chainId, token)} on ${describeChain(chainId)} but this swap needs ${formatUnits(amount, decimals)} (network costs come out of the input).`,
      "INSUFFICIENT_BALANCE",
      "Fund the wallet or lower --amount-in (a prior swap's `output` is an estimate, not the settled balance), then retry."
    );
  }
}

// ---------- Solana balance preflight ----------

const SOLANA_RENT_EXEMPT_MIN_LAMPORTS = 890_880n;

interface SolanaBalanceReads {
  getLamports(owner: string): Promise<bigint>;
  getSplBalance(owner: string, mint: string): Promise<bigint>;
}

function solanaBalanceReads(
  provider: ISolanaProviderAdapter
): SolanaBalanceReads {
  const rpc = provider.getRpc(SOLANA_MAINNET_PRIVY_CHAIN_ID);
  return {
    getLamports: async (owner) => {
      const { value } = await rpc.getBalance(solanaAddress(owner)).send();
      return BigInt(value);
    },
    getSplBalance: async (owner, mint) => {
      const { amount } = await getSplTokenBalance(
        rpc,
        solanaAddress(owner),
        solanaAddress(mint)
      );
      return amount;
    },
  };
}


export async function assertSufficientSolanaBalance(
  reads: SolanaBalanceReads,
  walletAddress: string,
  token: string,
  amount: bigint,
  decimals: number,
  json: boolean
): Promise<void> {
  const solNative: ResolvedTokenAlias | undefined = resolveTokenAlias(
    CHAIN_IDS.solana,
    "sol"
  );
  const isNativeSol =
    solNative !== undefined && String(solNative.address) === token;
  let balance: bigint;
  try {
    balance = isNativeSol
      ? await reads.getLamports(walletAddress)
      : await reads.getSplBalance(walletAddress, token);
  } catch (err) {
    progress(
      json,
      `Warning: could not read the Solana balance for the preflight check (${err instanceof Error ? err.message : String(err)}); continuing.`
    );
    return;
  }
  if (balance < amount) {
    throw new CliError(
      `The wallet holds ${formatUnits(balance, decimals)} ${describeToken(CHAIN_IDS.solana, token)} on solana but this swap needs ${formatUnits(amount, decimals)}.`,
      "INSUFFICIENT_BALANCE",
      "Fund the wallet or lower --amount-in, then retry."
    );
  }
  if (isNativeSol) {
    const remainder = balance - amount;
    if (remainder > 0n && remainder < SOLANA_RENT_EXEMPT_MIN_LAMPORTS) {
      throw new CliError(
        `--amount-in would leave ${formatUnits(remainder, 9)} SOL, below Solana's rent-exempt minimum (~${formatUnits(SOLANA_RENT_EXEMPT_MIN_LAMPORTS, 9)} SOL); the network rejects that.`,
        "VALIDATION_ERROR",
        "Lower --amount-in to leave at least 0.001 SOL, or swap the exact full balance."
      );
    }
  }
}

// ---------- Solana-origin SOL fee pipe ----------

const PIPE_BASIS_CANDIDATES = [
  { chainId: CHAIN_IDS.base, label: "base", symbol: "usdc" },
  { chainId: CHAIN_IDS.robinhood, label: "robinhood", symbol: "usdg" },
] as const;

interface PipeBasis {
  chainId: SupportedChainId;
  label: string;
  symbol: string;
  address: Address;
  decimals: number;
  amount: bigint;
}

async function resolvePipeBasis(
  provider: IEvmProviderAdapter,
  walletAddress: Address
): Promise<PipeBasis | undefined> {
  const unverified: PipeBasis[] = [];
  for (const candidate of PIPE_BASIS_CANDIDATES) {
    const alias: ResolvedTokenAlias | undefined = resolveTokenAlias(
      candidate.chainId,
      candidate.symbol
    );
    if (alias === undefined) continue;
    const address = parseEvmAddress(String(alias.address), "the pipe stable");
    const decimals = validAliasDecimals(alias.decimals);
    const basis: PipeBasis = {
      chainId: candidate.chainId,
      label: candidate.label,
      symbol: candidate.symbol,
      address,
      decimals,
      amount: parseUnits(SOL_TOPUP_STABLE_UNITS, decimals),
    };
    try {
      const balance = await readTokenBalance(
        provider,
        candidate.chainId,
        address,
        walletAddress
      );
      if (balance >= basis.amount) return basis;
    } catch {
      unverified.push(basis);
    }
  }
  return unverified[0];
}

async function pipeSolForSolanaOrigin(
  client: GeodesicsClient,
  provider: IEvmProviderAdapter,
  evmWalletAddress: Address,
  solanaWalletAddress: string,
  json: boolean
): Promise<boolean> {
  const basis = await resolvePipeBasis(provider, evmWalletAddress);
  const solNative: ResolvedTokenAlias | undefined = resolveTokenAlias(
    CHAIN_IDS.solana,
    "sol"
  );
  if (basis === undefined || solNative === undefined) {
    progress(
      json,
      `The wallet holds too little stable on ${PIPE_BASIS_CANDIDATES.map((c) => c.label).join(" or ")} to pipe SOL.`
    );
    return false;
  }
  progress(
    json,
    `Piping ${SOL_TOPUP_STABLE_UNITS} ${basis.symbol.toUpperCase()} on ${basis.label} into SOL for network fees...`
  );
  try {
    const pipeSwap = await client.swap(
      {
        originChain: basis.chainId,
        destinationChain: CHAIN_IDS.solana,
        inputToken: basis.address,
        outputToken: String(solNative.address),
        amount: basis.amount.toString(),
        walletAddress: evmWalletAddress,
        recipient: solanaWalletAddress,
      },
      createGeodesicsSwapSigner(provider),
      { onboardDestination: false }
    );
    if (pipeSwap.status !== "settled") {
      progress(
        json,
        `The SOL pipe ended ${pipeSwap.status} (swapId ${pipeSwap.swapId}).`
      );
      return false;
    }
    progress(json, "SOL piped; retrying the swap.");
    return true;
  } catch (pipeError) {
    progress(
      json,
      `The SOL pipe failed: ${pipeError instanceof Error ? pipeError.message : String(pipeError)}`
    );
    return false;
  }
}

export async function preflightSolanaQuote(
  client: GeodesicsClient,
  provider: IEvmProviderAdapter,
  request: QuoteRequest,
  confirmPipe: boolean,
  evmWalletAddress: Address,
  json: boolean
): Promise<QuoteResponse> {
  try {
    return await client.quote(request);
  } catch (quoteError) {
    if (
      !(quoteError instanceof GeodesicsApiError) ||
      quoteError.code !== "NEEDS_SOL_TOPUP"
    ) {
      return runGeodesics(() => Promise.reject(quoteError));
    }
    if (!confirmPipe) {
      throw new CliError(
        quoteError.message,
        "INSUFFICIENT_GAS",
        "Re-run with --confirm-pipe to fund it automatically (pipes ~1.5 of a basis-chain stable into SOL), or send ~0.005 SOL to the agent's Solana wallet."
      );
    }
    const piped = await pipeSolForSolanaOrigin(
      client,
      provider,
      evmWalletAddress,
      request.walletAddress,
      json
    );
    if (!piped) {
      throw new CliError(
        quoteError.message,
        "INSUFFICIENT_GAS",
        "The automatic SOL pipe did not complete; fund a basis-chain stable (Base USDC or Robinhood Chain USDG) or send ~0.005 SOL to the agent's Solana wallet, then retry."
      );
    }
    return runGeodesics(() => client.quote(request));
  }
}

// ---------- Error mapping + output ----------

const GEODESICS_ERROR_MAP: Record<
  string,
  { code: ErrorCode; recovery: string }
> = {
  INSUFFICIENT_BALANCE: {
    code: "INSUFFICIENT_BALANCE",
    recovery:
      "The wallet does not hold the input amount on the origin chain -- check `acp wallet balance`.",
  },
  NO_ROUTE: {
    code: "NO_ROUTE",
    recovery:
      "No route for this token pair -- check both token addresses and chains.",
  },
  NEEDS_LARGER_SIZE: {
    code: "NEEDS_LARGER_SIZE",
    recovery:
      "The amount is too small to cover network costs from the input -- retry with a larger --amount-in.",
  },
  SLIPPAGE: {
    code: "SLIPPAGE_TOO_LOW",
    recovery:
      "Price moved past the tolerance -- retry with a higher --slippage.",
  },
  UPSTREAM_TIMEOUT: {
    code: "TIMEOUT",
    recovery:
      "The route timed out upstream -- retry; the quote may simply have expired.",
  },
  UNSUPPORTED_DELEGATION: {
    code: "VALIDATION_ERROR",
    recovery:
      "This wallet's on-chain setup on the origin chain is incompatible -- swap from a different origin chain.",
  },
  NEEDS_SOL_TOPUP: {
    code: "INSUFFICIENT_GAS",
    recovery:
      "The agent's Solana wallet needs a small SOL balance (~0.005) for network fees -- re-run the swap with --confirm-pipe to fund it from a basis-chain stable, or send SOL to the agent's Solana address.",
  },
  NEEDS_DELEGATION: {
    code: "API_ERROR",
    recovery:
      "The wallet is not onboarded on the origin chain and the signer could not onboard it in-swap -- retry once, then contact Geodesics support.",
  },
  INVALID_AUTHORIZATION: {
    code: "API_ERROR",
    recovery: "The onboarding authorization went stale -- retry the swap.",
  },
};

export async function runGeodesics<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GeodesicsTimeoutError) {
      throw new CliError(
        `Timed out waiting for settlement of swap ${err.swapId} (last status: ${err.lastStatus}).`,
        "TIMEOUT",
        "The wait expired, not necessarily the swap -- it usually still settles. Check the destination balance shortly; only retry after confirming it did not settle."
      );
    }
    if (err instanceof GeodesicsApiError) {
      const mapped = err.code ? GEODESICS_ERROR_MAP[err.code] : undefined;
      throw new CliError(
        err.message,
        mapped?.code ?? "API_ERROR",
        mapped?.recovery ?? "See https://docs.geodesics.ai for error reference."
      );
    }
    throw err;
  }
}

function describeProgress(progress: SwapProgress): string {
  switch (progress.stage) {
    case "quoted": {
      const feePct = (progress.feeBps / 100).toFixed(3);
      return `Quoted -- fee ${feePct}%, expires ${progress.expiresAt}`;
    }
    case "authorizing":
      return `First swap from chain ${progress.chainId} -- onboarding rides inside the swap`;
    case "submitted":
      return `Submitted -- swap ${progress.swapId}`;
    case "polled":
      return `Status: ${progress.status}`;
    default:
      return progress.stage;
  }
}

function progress(json: boolean, msg: string): void {
  if (json || !isTTY()) return;
  process.stderr.write(`${msg}\n`);
}
