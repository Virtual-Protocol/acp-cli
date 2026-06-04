// `acp trade` — one command for moving and trading value. The chains you pass
// decide the venue: Hyperliquid is chain 1337, so swaps, HL deposits, HL spot,
// and HL withdrawals all share the same --token-in/--chain-in/--amount-in/
// --token-out/--chain-out shape. Only perps are different (a leveraged position,
// not a token conversion), so they use --side long|short.
//
// ── Intent routing (for LLM agents and humans) ──────────────────────────────
//   --token <sym> --side long|short           → Hyperliquid PERP (leveraged)
//   --token <sym> --amount-usdc|--amount-shares → Treasures TOKENIZED STOCK (spot)
//   --chain-in 1337  --chain-out 1337         → Hyperliquid SPOT (order book)
//   --chain-in <evm> --chain-out 1337         → DEPOSIT USDC into Hyperliquid
//   --chain-in 1337  --chain-out <evm>        → WITHDRAW USDC from Hyperliquid
//   --chain-in <evm> --chain-out <evm>        → SWAP (DEX: BondingV5 / LiFi)
//   (no flags, in a terminal)                 → interactive picker (humans only)
//
// One asset flag everywhere: --token names the symbol (BTC, AAPL, …); the
// companion flag picks the venue — --side → leveraged HL perp, --amount-usdc/
// --amount-shares → Treasures spot tokenized stock.
//
// `acp trade status` shows HL positions/margin/balances (read-only).
//
// Spot amount semantics mirror a swap: a BUY (--token-in usdc) spends --amount-in
// USDC (size derived from price, never overspends); a SELL (--token-out usdc)
// sells --amount-in token units.
//
// How signing works: the CLI is a thin signer. Swaps/deposits run through the
// ACP backend's /trade/plan + /trade/next proxy (authenticated with the same
// bearer token as every other ACP command), which forwards to the internal
// trading-agent state machine — the server builds calldata, the CLI
// signs+broadcasts each leg with the keystore-backed signer (no human prompt).
// HL spot/perp/withdraw are EIP-712 actions signed by the same signer and
// POSTed to HL's API. Private keys never leave the keystore.
//
// No extra env vars: `acp configure` auth is all that's required. The
// trading-agent URL + key live only on the backend.

import type { Command } from "commander";
import type { Address } from "viem";
import * as readline from "readline";
import { isJson, isTTY, outputError, outputResult } from "../lib/output";
import { CliError, type ErrorCode } from "../lib/errors";
import { getApiContext } from "../lib/api/client";
import {
  createProviderAdapter,
  getWalletAddress,
} from "../lib/agentFactory";
import type { IEvmProviderAdapter } from "@virtuals-protocol/acp-node-v2";
import { prompt, selectOption } from "../lib/prompt";
import {
  createHlClients,
  createHlInfoClient,
  formatSize,
  formatPrice,
  isTestnet,
  marketPrice,
  resolvePerpAsset,
  resolveSpotAsset,
} from "../lib/hl/client";
// LiFi's chain id for Hyperliquid Core (the perps/spot collateral ledger).
// Any leg whose chain is this is "on Hyperliquid".
const HL_CHAIN_ID = 1337;
// Default source chain for a deposit's USDC.
const DEFAULT_FROM_CHAIN = 8453; // Base
// Minimum deposit. Bridge fees are ~flat (~$1.2), so small deposits lose a
// large % (≈25% at $5, ≈5% at $25). $5 floor is for testing; raise for prod.
const MIN_DEPOSIT_USDC = 5;

// ---------- Wire types (mirror trading-agent/src/services/trade/types.ts) ----------

interface SendAction {
  kind: "send";
  label: string;
  to: string;
  data: string;
  value: string;
  chainId: number;
  expectedTxKind?: string;
  timeoutMs?: number;
}
interface SignAction {
  kind: "sign";
  label: string;
  sigType: "personal" | "eip712";
  chainId: number;
  message?: string; // personal_sign
  typedData?: unknown; // EIP-712
  expectedSignKind?: string;
  timeoutMs?: number;
}
interface WaitAction {
  kind: "wait";
  label: string;
  delaySec: number;
  maxDelaySec?: number;
}
interface DoneAction {
  kind: "done";
  status: "success" | "partial";
  result: Record<string, unknown>;
}
interface ErrorAction {
  kind: "error";
  code: string;
  message: string;
  recovery?: string;
  retryable: boolean;
  partialResult?: Record<string, unknown>;
}
type Action = SendAction | SignAction | WaitAction | DoneAction | ErrorAction;

interface PlanResponse {
  tradeId: string;
  step: number;
  direction?: string;
  route?: string;
  totalTaxBps?: number;
  appliedSlippageBps?: number;
  recipient?: string;
  action: Action;
}
interface NextResponse {
  tradeId: string;
  step: number;
  action: Action;
}

// ---------- Command registration ----------

export function registerTradeCommands(program: Command): void {
  const trade = program
    .command("trade")
    .description(
      "Trade value: same/cross-chain swaps, and — via Hyperliquid (chain 1337) — " +
        "deposits, spot orders, withdrawals, and perps. Routes by the chains/params " +
        "you pass. See `acp trade --help`."
    )
    .addHelpText(
      "after",
      "\nHyperliquid is chain 1337. The chains decide the venue:\n" +
        "  --chain-in <evm>  --chain-out <evm>   → DEX swap (same/cross-chain)\n" +
        "  --chain-in <evm>  --chain-out 1337    → deposit USDC into Hyperliquid\n" +
        "  --chain-in 1337   --chain-out 1337    → Hyperliquid spot order\n" +
        "  --chain-in 1337   --chain-out <evm>   → withdraw USDC from Hyperliquid\n" +
        "  --token <sym> --side long|short       → Hyperliquid perp (leveraged; crypto, stocks, FX, commodities)\n" +
        "  --token <sym> --amount-usdc|-shares   → Treasures tokenized stock (spot buy/sell, USDC on Ethereum)\n" +
        "  --token <sym> --token-in/-chain-in/-amount-in (no --token-out) → Treasures buy funded from any chain\n" +
        "  (no flags, in a terminal)             → interactive picker\n" +
        "\nExamples:\n" +
        "  acp trade --token-in usdc --chain-in 8453 --amount-in 50 --token-out virtual --chain-out 8453\n" +
        "  acp trade --token-in usdc --chain-in 1 --amount-in 100 --token-out usdc --chain-out 8453\n" +
        "  acp trade --token-in usdc --chain-in 8453 --amount-in 25 --token-out usdc --chain-out 1337   # deposit\n" +
        "  acp trade --token-in usdc --chain-in 1337 --amount-in 100 --token-out PURR --chain-out 1337  # spot buy\n" +
        "  acp trade --token-in PURR --chain-in 1337 --amount-in 50 --token-out usdc --chain-out 1337   # spot sell\n" +
        "  acp trade --token-in usdc --chain-in 1337 --amount-in 25 --token-out usdc --chain-out 42161  # withdraw\n" +
        "  acp trade --side long --token BTC --size 0.01 --leverage 5\n" +
        "  acp trade --token AAPL --amount-usdc 50                          # buy tokenized AAPL with USDC on Ethereum\n" +
        "  acp trade --token AAPL --token-in eth --chain-in 8453 --amount-in 0.02  # buy AAPL, funded by ETH on Base\n" +
        "  acp trade --token AAPL --amount-shares 0.1                       # sell 0.1 tokenized AAPL shares (Treasures)\n" +
        "  acp trade status\n"
    )
    // -- Swap / deposit / HL spot / HL withdraw (token-pair shape) --------
    .option("--token-in <token>", "Input token (address or symbol)")
    .option("--chain-in <id>", "Input chain ID (1337 = Hyperliquid)")
    .option("--amount-in <amount>", "Input amount in human units (USDC for an HL spot buy)")
    .option("--token-out <token>", "Output token (address or symbol)")
    .option("--chain-out <id>", "Output chain ID (1337 = Hyperliquid)")
    .option("--recipient <addr>", "Output recipient (default: active wallet)")
    .option("--slippage-bps <bps>", "Swap/bridge slippage in basis points")
    .option("--deadline-secs <secs>", "BondingV5 deadline in seconds")
    .option("--price <price>", "HL spot limit price (omit for a market order)")
    .option("--post-only", "HL post-only (Alo) limit order; rejects if it crosses", false)
    .option("--slippage <pct>", "HL market-order slippage as a percent (default 5)", "5")
    // -- Treasures tokenized stock (USDC ↔ stock token swap) -------------
    // The asset is named with --token (below); these flags pick buy vs sell.
    .option("--amount-usdc <amount>", "USDC to spend on a Treasures tokenized-stock buy (with --token)")
    .option("--amount-shares <amount>", "Shares to liquidate on a Treasures tokenized-stock sell (with --token)")
    .option("--protocol <name>", "Treasures protocol filter: ondo or xstocks")
    .option("--chain <name>", "Treasures venue filter: eth (sol legs can't be signed by the CLI)")
    // -- Hyperliquid perp (position shape) -------------------------------
    .option("--side <side>", "Perp side: long or short")
    .option(
      "--token <symbol>",
      "Asset symbol. With --side → HL perp (crypto/stock/FX/commodity, e.g. BTC). " +
        "With --amount-usdc/--amount-shares → Treasures tokenized stock (e.g. AAPL)"
    )
    .option("--size <size>", "Perp order size in token units")
    .option("--leverage <n>", "Set leverage for this token before a perp order")
    .option("--isolated", "Use isolated margin when setting leverage", false)
    .option("--reduce-only", "Only reduce an existing perp position", false)
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const intent = detectIntent(opts, json);
        switch (intent) {
          case "treasures-stock":
            await runTreasuresStock(opts, json);
            return;
          case "perp":
            await runPerp(opts, json);
            return;
          case "spot":
            await runHlSpot(opts, json);
            return;
          case "deposit":
          case "swap":
            await runSwap(opts, json);
            return;
          case "withdraw":
            await runWithdraw(
              String(opts.amountIn),
              opts.recipient as string | undefined,
              json,
              opts.chainOut !== undefined ? Number(opts.chainOut) : undefined
            );
            return;
          case "interactive":
            await runInteractive(json);
            return;
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // ── status ────────────────────────────────────────────────────────────────
  trade
    .command("status")
    .description("Show HL account: perp positions, margin, and spot balances")
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);
      try {
        await runStatus(json);
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // ── withdraw ──────────────────────────────────────────────────────────────
  // Convenience form. (Equivalent to: --token-in usdc --chain-in 1337
  // --amount-in <n> --token-out usdc --chain-out <evm>.)
  trade
    .command("withdraw")
    .description("Withdraw USDC from Hyperliquid L1 to Arbitrum (signed action)")
    .requiredOption("--amount <usdc>", "USDC amount to withdraw")
    .option("--destination <addr>", "Destination address (default: active wallet)")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        await runWithdraw(String(opts.amount), opts.destination, json);
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}

// ---------- Intent routing ----------

type Intent =
  | "treasures-stock"
  | "perp"
  | "spot"
  | "deposit"
  | "withdraw"
  | "swap"
  | "interactive";

// --side selects the perp venue and takes ONLY `long` or `short`. It's a perps
// directional flag, so we deliberately do NOT accept buy/sell — those are spot
// terms (a spot buy/sell is expressed via token-in/out direction, never --side),
// and accepting them here would let `--side sell` look like a spot sell while
// actually opening a perp short. detectIntent and parsePerpSide share this set
// so they can never disagree on what counts as a valid side.
const PERP_SIDES = new Set(["long", "short"]);
function isPerpSide(side: string): boolean {
  return PERP_SIDES.has(side.trim().toLowerCase());
}

export function detectIntent(opts: Record<string, unknown>, json: boolean): Intent {
  // --amount-usdc / --amount-shares are Treasures-exclusive (swaps use
  // --amount-in, perps use --size), so either one is the unambiguous tokenized
  // -stock signal and wins over every other route — it means the user wants
  // `/quote/buy` or `/quote/sell` and nothing else can match. The asset is
  // named with --token (shared with perps); --side selects a leveraged perp,
  // an --amount-* selects Treasures spot, which settles a stock-token ERC-20
  // into the wallet (not a position), so it sits next to swaps shape-wise.
  if (opts.amountUsdc !== undefined || opts.amountShares !== undefined) {
    return "treasures-stock";
  }

  const side = typeof opts.side === "string" ? opts.side.toLowerCase() : undefined;
  // --side is the unambiguous perp signal. If it's present it MUST be long or
  // short — reject anything else up front rather than silently falling through
  // to chain-based routing (which would run a swap and ignore the bad --side).
  if (side !== undefined) {
    if (!isPerpSide(side)) {
      throw new CliError(
        `Invalid --side: ${String(opts.side)}`,
        "VALIDATION_ERROR",
        "Use --side long or --side short (perps only). A spot buy/sell is set by token-in/out direction, not --side."
      );
    }
    return "perp";
  }

  // Funded Treasures buy: --token names a stock ticker and the funds come via
  // the swap-shape flags (--token-in/--chain-in/--amount-in), but there's no
  // --token-out/--chain-out — the "out" is the tokenized stock named by
  // --token. That missing destination is what distinguishes it from a swap, so
  // we route it to Treasures (the server bridges to USDC@eth, then buys).
  if (
    opts.token !== undefined &&
    opts.tokenOut === undefined &&
    opts.chainOut === undefined &&
    (opts.tokenIn !== undefined ||
      opts.chainIn !== undefined ||
      opts.amountIn !== undefined)
  ) {
    return "treasures-stock";
  }

  const hasTokenParams =
    opts.tokenIn !== undefined ||
    opts.tokenOut !== undefined ||
    opts.chainIn !== undefined ||
    opts.chainOut !== undefined ||
    opts.amountIn !== undefined;

  if (hasTokenParams) {
    const inHL = opts.chainIn !== undefined && Number(opts.chainIn) === HL_CHAIN_ID;
    const outHL = opts.chainOut !== undefined && Number(opts.chainOut) === HL_CHAIN_ID;
    if (inHL && outHL) return "spot";
    if (inHL) {
      // chain-in 1337 with no chain-out is ambiguous: it's almost always a spot
      // order missing `--chain-out 1337`, not a withdraw. Withdraw requires an
      // explicit EVM destination, so demand chain-out rather than silently
      // moving funds off Hyperliquid.
      if (!outHL && opts.chainOut === undefined) {
        throw new CliError(
          "--chain-in 1337 needs an explicit --chain-out.",
          "VALIDATION_ERROR",
          "Use `--chain-out 1337` for an HL spot order, or an EVM chain id (e.g. `--chain-out 8453`) to withdraw from Hyperliquid."
        );
      }
      return "withdraw";
    }
    if (outHL) return "deposit";
    return "swap";
  }

  // Bare --token with no pair params (an incomplete perp) → perp path, which
  // surfaces a clear "--side is required" error.
  if (opts.token !== undefined) return "perp";

  if (!json && isTTY()) return "interactive";

  throw new CliError(
    "No trade intent in the flags provided.",
    "VALIDATION_ERROR",
    "Run `acp trade --help` for the chain→venue routing and examples."
  );
}

// ---------- Swap / deposit (trading-agent state machine) ----------

async function runSwap(opts: Record<string, unknown>, json: boolean): Promise<void> {
  const { apiUrl, token } = await getApiContext();
  const owner = getWalletAddress() as Address;
  const provider = await createProviderAdapter();

  const chainOut = opts.chainOut !== undefined ? Number(opts.chainOut) : undefined;
  const isDeposit = chainOut === HL_CHAIN_ID;

  // Deposit conveniences: default the source chain + tokens to USDC and enforce
  // the bridge-fee floor so tiny deposits don't get eaten by fees.
  const tokenIn = (opts.tokenIn as string | undefined) ?? (isDeposit ? "USDC" : undefined);
  const tokenOut = (opts.tokenOut as string | undefined) ?? (isDeposit ? "USDC" : undefined);
  const chainIn =
    opts.chainIn !== undefined
      ? Number(opts.chainIn)
      : isDeposit
        ? DEFAULT_FROM_CHAIN
        : undefined;

  const missing: string[] = [];
  if (!tokenIn) missing.push("--token-in");
  if (chainIn === undefined) missing.push("--chain-in");
  if (opts.amountIn === undefined) missing.push("--amount-in");
  if (!tokenOut) missing.push("--token-out");
  if (chainOut === undefined) missing.push("--chain-out");
  if (missing.length) {
    throw new CliError(
      `Missing required option(s): ${missing.join(", ")}`,
      "VALIDATION_ERROR",
      isDeposit
        ? "For a deposit: `acp trade --amount-in 25 --chain-out 1337`."
        : "e.g. `acp trade --token-in usdc --chain-in 8453 --amount-in 50 --token-out virtual --chain-out 8453`."
    );
  }

  if (isDeposit) {
    const amount = Number(opts.amountIn);
    if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_USDC) {
      throw new CliError(
        `Minimum Hyperliquid deposit is ${MIN_DEPOSIT_USDC} USDC.`,
        "VALIDATION_ERROR",
        `Pass --amount-in ${MIN_DEPOSIT_USDC} or more.`
      );
    }
  }

  const planBody = {
    tokenIn,
    chainIn,
    amountIn: String(opts.amountIn),
    tokenOut,
    chainOut,
    slippageBps: opts.slippageBps !== undefined ? Number(opts.slippageBps) : undefined,
    deadlineSecs: opts.deadlineSecs !== undefined ? Number(opts.deadlineSecs) : undefined,
    recipient: (opts.recipient as string | undefined) ?? (isDeposit ? owner : undefined),
    walletAddress: owner,
  };

  const plan: PlanResponse = await post(apiUrl, token, "/trade/plan", planBody);
  if (isDeposit) {
    progress(
      json,
      `HL deposit ${plan.tradeId.slice(0, 8)} — ${opts.amountIn} ${tokenIn} ` +
        `(chain ${chainIn}) → Hyperliquid`
    );
  } else {
    progress(
      json,
      `Trade ${plan.tradeId.slice(0, 8)}` +
        (plan.direction && plan.route ? ` (${plan.direction} via ${plan.route})` : "")
    );
  }
  const result = await runTradeLoop(apiUrl, token, provider, plan, json);
  outputResult(json, result);
}

export async function runTradeLoop(
  url: string,
  token: string,
  provider: IEvmProviderAdapter,
  plan: PlanResponse,
  json: boolean
): Promise<Record<string, unknown>> {
  let action = plan.action;
  let step = plan.step;

  while (true) {
    if (action.kind === "done") return action.result;
    if (action.kind === "error") {
      if (action.partialResult && !json && isTTY()) {
        process.stderr.write(
          "Partial state:\n" + JSON.stringify(action.partialResult, null, 2) + "\n"
        );
      }
      throw new CliError(
        action.message,
        isKnownCode(action.code) ? action.code : "API_ERROR",
        action.recovery
      );
    }

    let nextBody: Record<string, unknown>;
    if (action.kind === "send") {
      progress(json, `[step ${step + 1}] ${action.label}`);
      try {
        const txHash = await provider.sendTransaction(action.chainId, {
          to: action.to as `0x${string}`,
          data: action.data as `0x${string}`,
          ...(action.value && action.value !== "0"
            ? { value: BigInt(action.value) }
            : {}),
        });
        nextBody = { tradeId: plan.tradeId, step, txHash };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        nextBody = {
          tradeId: plan.tradeId,
          step,
          error: { code: "TX_FAILED", message },
        };
      }
    } else if (action.kind === "sign") {
      // The server asks the CLI to produce a signature (NOT broadcast a tx):
      // an EIP-191 personal_sign or an EIP-712 typed-data signature. We sign
      // with the keystore-backed signer and post the signature back. Used by
      // the Treasures flow (ownership proof + Fusion orders the server submits).
      progress(json, `[step ${step + 1}] ${action.label}`);
      try {
        const signature =
          action.sigType === "eip712"
            ? await provider.signTypedData(action.chainId, action.typedData)
            : await provider.signMessage(action.chainId, action.message ?? "");
        nextBody = { tradeId: plan.tradeId, step, signature };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        nextBody = {
          tradeId: plan.tradeId,
          step,
          error: { code: "SIGN_FAILED", message },
        };
      }
    } else if (action.kind === "wait") {
      progress(json, `[step ${step + 1}] ${action.label} (waiting ${action.delaySec}s)`);
      await sleep(action.delaySec * 1000);
      nextBody = { tradeId: plan.tradeId, step };
    } else {
      throw new CliError(
        `Unknown action kind: ${(action as { kind: string }).kind}`,
        "API_ERROR"
      );
    }

    const next: NextResponse = await post(url, token, "/trade/next", nextBody);
    action = next.action;
    step = next.step;
  }
}

// ---------- Hyperliquid spot (token-pair shape on chain 1337) ----------

function isUsdcSymbol(token: string): boolean {
  return token.trim().toLowerCase() === "usdc";
}

async function runHlSpot(opts: Record<string, unknown>, json: boolean): Promise<void> {
  const tokenIn = opts.tokenIn !== undefined ? String(opts.tokenIn) : undefined;
  const tokenOut = opts.tokenOut !== undefined ? String(opts.tokenOut) : undefined;
  if (!tokenIn || !tokenOut || opts.amountIn === undefined) {
    throw new CliError(
      "HL spot needs --token-in, --token-out, and --amount-in (both chains 1337).",
      "VALIDATION_ERROR",
      "e.g. `acp trade --token-in usdc --chain-in 1337 --amount-in 100 --token-out PURR --chain-out 1337`."
    );
  }
  const inUsdc = isUsdcSymbol(tokenIn);
  const outUsdc = isUsdcSymbol(tokenOut);
  if (inUsdc === outUsdc) {
    throw new CliError(
      "HL spot pairs are USDC-quoted: exactly one of --token-in / --token-out must be USDC.",
      "VALIDATION_ERROR",
      "Buy: `--token-in usdc --token-out PURR`. Sell: `--token-in PURR --token-out usdc`."
    );
  }
  // Buy when the output is the token (spending USDC); sell when the input is the token.
  const isBuy = !outUsdc ? true : false;
  const token = isBuy ? tokenOut : tokenIn;

  const { info, exchange, address } = await createHlClients();
  const asset = await resolveSpotAsset(info, token);

  const isMarket = opts.price === undefined;
  const orderPrice = isMarket
    ? await marketPrice(
        info,
        asset.midKey,
        isBuy,
        asset.szDecimals,
        true,
        parseSlippage(String(opts.slippage ?? "5"))
      )
    : formatPrice(Number(opts.price), asset.szDecimals, true);

  // Size: a sell spends token units directly; a buy spends USDC, so size is the
  // USDC amount divided by the order price (so the order never overspends).
  const amountIn = Number(opts.amountIn);
  if (!Number.isFinite(amountIn) || amountIn <= 0) {
    throw new CliError(`Invalid --amount-in: ${opts.amountIn}`, "VALIDATION_ERROR");
  }
  const sizeNum = isBuy ? amountIn / Number(orderPrice) : amountIn;
  const size = formatSize(sizeNum, asset.szDecimals);

  // A spot buy spends USDC from the spot wallet — top it up from perp if short.
  // (A sell needs the token itself, which no USDC transfer can provide.)
  if (isBuy) {
    await ensureHlFunds(info, exchange, address, "spot", amountIn, json);
  }

  progress(
    json,
    `${isMarket ? "Market" : "Limit"} ${isBuy ? "buy" : "sell"} ${size} ${asset.name} @ ${orderPrice}`
  );

  await placeHlOrder(
    exchange,
    {
      orders: [
        {
          a: asset.assetIndex,
          b: isBuy,
          p: orderPrice,
          s: size,
          r: false,
          t: { limit: { tif: isMarket ? "Ioc" : opts.postOnly ? "Alo" : "Gtc" } },
        },
      ],
      grouping: "na",
    },
    json
  );
}

// ---------- Hyperliquid perp (position shape) ----------

async function runPerp(opts: Record<string, unknown>, json: boolean): Promise<void> {
  if (opts.token === undefined) {
    throw new CliError("--token is required for a perp.", "VALIDATION_ERROR", "e.g. `--token BTC`.");
  }
  if (opts.side === undefined) {
    throw new CliError(
      "--side long|short is required for a perp.",
      "VALIDATION_ERROR",
      "e.g. `--token BTC --side long --size 0.01`."
    );
  }
  if (opts.size === undefined) {
    throw new CliError("--size is required for a perp.", "VALIDATION_ERROR");
  }
  const isBuy = parsePerpSide(String(opts.side));
  const { info, exchange, address } = await createHlClients();
  const asset = await resolvePerpAsset(info, String(opts.token));

  if (opts.leverage !== undefined) {
    await exchange.updateLeverage({
      asset: asset.assetIndex,
      isCross: !opts.isolated,
      leverage: Number(opts.leverage),
    });
    progress(json, `Set ${asset.name} leverage to ${opts.leverage}x`);
  }

  const size = formatSize(Number(opts.size), asset.szDecimals);
  const isMarket = opts.price === undefined;
  const price = isMarket
    ? await marketPrice(
        info,
        asset.midKey,
        isBuy,
        asset.szDecimals,
        false,
        parseSlippage(String(opts.slippage ?? "5"))
      )
    : formatPrice(Number(opts.price), asset.szDecimals, false);

  // Opening/adding to a position consumes perp margin — top it up from the spot
  // wallet if short. Required initial margin ≈ notional / leverage (×1.05 for
  // fees). Skip for reduce-only (closing frees margin, never needs more). When
  // leverage isn't given we don't know the account default, so assume 1x — a
  // conservative over-estimate that just moves more idle USDC into perp.
  if (!opts.reduceOnly) {
    const notional = Number(size) * Number(price);
    const lev = opts.leverage !== undefined ? Number(opts.leverage) : 1;
    const needMargin = (notional / Math.max(lev, 1)) * 1.05;
    await ensureHlFunds(info, exchange, address, "perp", needMargin, json);
  }

  progress(
    json,
    `${isMarket ? "Market" : "Limit"} ${opts.side} ${size} ${asset.name} @ ${price}`
  );

  await placeHlOrder(
    exchange,
    {
      orders: [
        {
          a: asset.assetIndex,
          b: isBuy,
          p: price,
          s: size,
          r: Boolean(opts.reduceOnly),
          t: { limit: { tif: isMarket ? "Ioc" : opts.postOnly ? "Alo" : "Gtc" } },
        },
      ],
      grouping: "na",
    },
    json
  );
}

// ---------- Hyperliquid account ----------

async function runStatus(json: boolean): Promise<void> {
  // Read-only: needs the wallet address, not the signer.
  const info = createHlInfoClient();
  const address = getWalletAddress() as Address;
  const [perp, spot] = await Promise.all([
    info.clearinghouseState({ user: address }),
    info.spotClearinghouseState({ user: address }),
  ]);

  const positions = perp.assetPositions.map((p) => ({
    token: p.position.coin,
    size: p.position.szi,
    entryPx: p.position.entryPx,
    unrealizedPnl: p.position.unrealizedPnl,
    leverage: p.position.leverage,
  }));
  const balances = spot.balances.map((b) => ({
    token: b.coin,
    total: b.total,
    hold: b.hold,
  }));

  outputResult(json, {
    address,
    network: isTestnet() ? "testnet" : "mainnet",
    accountValue: perp.marginSummary.accountValue,
    withdrawable: perp.withdrawable,
    positions,
    spotBalances: balances,
  });
}

// Hyperliquid's withdraw3 always settles USDC on Arbitrum — there is no
// choice of destination chain.
const HL_WITHDRAW_CHAIN_ID = 42161;

async function runWithdraw(
  amount: string,
  destination: string | undefined,
  json: boolean,
  chainOut?: number
): Promise<void> {
  if (amount === undefined || amount === "undefined" || amount === "") {
    throw new CliError(
      "--amount-in is required to withdraw from Hyperliquid.",
      "VALIDATION_ERROR",
      "e.g. `acp trade --token-in usdc --chain-in 1337 --amount-in 25 --token-out usdc --chain-out 42161`."
    );
  }
  // detectIntent requires an explicit --chain-out for a withdraw; honor it by
  // rejecting any non-Arbitrum target rather than silently settling on
  // Arbitrum when the user asked for a different chain.
  if (chainOut !== undefined && chainOut !== HL_WITHDRAW_CHAIN_ID) {
    throw new CliError(
      `Hyperliquid withdrawals settle on Arbitrum (${HL_WITHDRAW_CHAIN_ID}); --chain-out ${chainOut} is not supported.`,
      "VALIDATION_ERROR",
      "Use `--chain-out 42161` to withdraw from Hyperliquid."
    );
  }
  const { exchange, address } = await createHlClients();
  const dest = (destination ?? address) as Address;
  progress(json, `Withdrawing ${amount} USDC → ${dest}`);
  const res = await exchange.withdraw3({ destination: dest, amount: String(amount) });
  outputResult(json, { status: res.status, destination: dest, amount: String(amount) });
}

// ---------- Treasures tokenized stock (USDC ↔ stock token swap) ----------
//
// The Treasures flow lives in the trading-agent planner now: the CLI POSTs a
// plan with a `treasures` block and drives the same /trade/plan + /trade/next
// loop as a swap. The server quotes, picks legs, submits, and polls; it asks
// the CLI to sign via `sign` actions (the ownership proof + each EIP-712 Fusion
// order). Spot stocks settle in USDC on Ethereum, so a buy can name a funding
// source on any chain (--token-in/--chain-in/--amount-in) and the server
// bridges to USDC@eth first. The CLI stays a thin signer; runTradeLoop already
// handles every action kind.

async function runTreasuresStock(
  opts: Record<string, unknown>,
  json: boolean
): Promise<void> {
  if (opts.token === undefined) {
    throw new CliError(
      "A Treasures tokenized-stock trade needs --token <ticker>.",
      "VALIDATION_ERROR",
      "e.g. `acp trade --token AAPL --amount-usdc 50` (buy) or " +
        "`acp trade --token AAPL --amount-shares 0.1` (sell)."
    );
  }
  const ticker = String(opts.token).trim().toUpperCase();
  const amountUsdc =
    opts.amountUsdc !== undefined ? String(opts.amountUsdc) : undefined;
  const amountShares =
    opts.amountShares !== undefined ? String(opts.amountShares) : undefined;
  const hasFunding =
    opts.tokenIn !== undefined ||
    opts.chainIn !== undefined ||
    opts.amountIn !== undefined;

  const slippageBps =
    opts.slippageBps !== undefined
      ? parseTreasuresSlippageBps(opts.slippageBps)
      : undefined;
  const protocol =
    opts.protocol !== undefined
      ? validateTreasuresProtocol(String(opts.protocol))
      : undefined;
  const chainFilter =
    opts.chain !== undefined
      ? validateTreasuresChain(String(opts.chain))
      : undefined;

  // Direction + amount source. A sell takes only --amount-shares; a buy spends
  // either USDC already on Ethereum (--amount-usdc) or funds bridged from
  // another chain (--token-in/--chain-in/--amount-in).
  const treasures: Record<string, unknown> = {
    ticker,
    ...(slippageBps !== undefined ? { slippageBps } : {}),
    ...(protocol ? { protocol } : {}),
    ...(chainFilter ? { chainFilter } : {}),
  };

  if (amountShares !== undefined) {
    if (amountUsdc !== undefined || hasFunding) {
      throw new CliError(
        "A Treasures sell takes only --amount-shares (it delivers USDC on Ethereum).",
        "VALIDATION_ERROR",
        "e.g. `acp trade --token AAPL --amount-shares 0.1`."
      );
    }
    treasures.side = "sell";
    treasures.amountShares = amountShares;
  } else if (amountUsdc !== undefined) {
    if (hasFunding) {
      throw new CliError(
        "Use either --amount-usdc (spend USDC on Ethereum) or a funding source (--token-in/--chain-in/--amount-in), not both.",
        "VALIDATION_ERROR"
      );
    }
    treasures.side = "buy";
    treasures.amountUsdc = amountUsdc;
  } else if (hasFunding) {
    // Funded buy — bridge the source token to USDC@eth, then buy.
    if (
      opts.tokenIn === undefined ||
      opts.chainIn === undefined ||
      opts.amountIn === undefined
    ) {
      throw new CliError(
        "A funded Treasures buy needs --token-in, --chain-in, and --amount-in.",
        "VALIDATION_ERROR",
        "e.g. `acp trade --token AAPL --token-in eth --chain-in 8453 --amount-in 0.02`."
      );
    }
    treasures.side = "buy";
    treasures.fromToken = String(opts.tokenIn);
    treasures.fromChain = Number(opts.chainIn);
    treasures.amountIn = String(opts.amountIn);
  } else {
    throw new CliError(
      "A Treasures trade needs --amount-usdc (buy), --amount-shares (sell), or a funding source (--token-in/--chain-in/--amount-in).",
      "VALIDATION_ERROR",
      "e.g. `acp trade --token AAPL --amount-usdc 50` (buy) or " +
        "`acp trade --token AAPL --token-in eth --chain-in 8453 --amount-in 0.02` (funded buy)."
    );
  }

  const { apiUrl, token } = await getApiContext();
  const owner = getWalletAddress() as Address;
  const provider = await createProviderAdapter();

  const plan: PlanResponse = await post(apiUrl, token, "/trade/plan", {
    walletAddress: owner,
    treasures,
  });
  progress(
    json,
    `Treasures ${plan.tradeId.slice(0, 8)} — ${String(treasures.side)} ${ticker}` +
      (plan.route ? ` (${plan.route})` : "")
  );
  const result = await runTradeLoop(apiUrl, token, provider, plan, json);
  outputResult(json, result);
}

// Guard the bps before it hits JSON.stringify — an un-validated Number() turns
// garbage into NaN, which serializes as `max_slippage_bps: null` and quietly
// drops the cap server-side. Require a non-negative whole number of bps.
function parseTreasuresSlippageBps(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new CliError(
      `Invalid --slippage-bps: ${String(raw)}`,
      "VALIDATION_ERROR",
      "Pass a non-negative whole number of basis points, e.g. 300 (=3%)."
    );
  }
  return n;
}

function validateTreasuresProtocol(s: string): "ondo" | "xstocks" {
  const v = s.trim().toLowerCase();
  if (v === "ondo" || v === "xstocks") return v;
  throw new CliError(
    `Invalid --protocol: ${s}`,
    "VALIDATION_ERROR",
    "Use --protocol ondo or --protocol xstocks."
  );
}

function validateTreasuresChain(s: string): "sol" | "eth" {
  const v = s.trim().toLowerCase();
  if (v === "sol" || v === "eth") return v;
  throw new CliError(
    `Invalid --chain: ${s}`,
    "VALIDATION_ERROR",
    "Use --chain sol or --chain eth."
  );
}

// Auto-balance the HL sub-wallets. HL keeps perp (collateral) and spot USDC in
// separate wallets; deposits land in perp. Before an order, if the wallet that
// must fund it is short, move the shortfall over from the other wallet so an
// agent never has to think about which sub-wallet holds the money.
//   target "spot" → fund a spot buy from the perp wallet
//   target "perp" → fund a perp order from the spot wallet
// `needUsd` is the USDC the order requires in `target`. Over-transferring is
// harmless (it's an instant, free L1 move), so we only ever move the shortfall.
type HlExchange = Awaited<ReturnType<typeof createHlClients>>["exchange"];
type HlInfo = Awaited<ReturnType<typeof createHlClients>>["info"];

async function ensureHlFunds(
  info: HlInfo,
  exchange: HlExchange,
  address: Address,
  target: "spot" | "perp",
  needUsd: number,
  json: boolean
): Promise<void> {
  if (!Number.isFinite(needUsd) || needUsd <= 0) return;
  const [perp, spot] = await Promise.all([
    info.clearinghouseState({ user: address }),
    info.spotClearinghouseState({ user: address }),
  ]);
  const spotUsdc = Number(spot.balances.find((b) => b.coin === "USDC")?.total ?? "0");
  const perpFree = Number(perp.withdrawable ?? "0");
  const have = target === "spot" ? spotUsdc : perpFree;
  if (have >= needUsd) return;

  const sourceAvail = target === "spot" ? perpFree : spotUsdc;
  const move = Math.min(needUsd - have, sourceAvail);
  const source = target === "spot" ? "perp" : "spot";
  if (move <= 0) {
    progress(
      json,
      `${target} wallet has $${have.toFixed(2)}, order needs ~$${needUsd.toFixed(2)}, ` +
        `and no ${source} funds to cover it — letting HL size/limit the order`
    );
    return;
  }
  const amount = move.toFixed(2);
  progress(json, `Auto-transfer $${amount} ${source}→${target} to fund the order`);
  await exchange.usdClassTransfer({ amount, toPerp: target === "perp" });
}

// ---------- Interactive picker (humans only) ----------

interface PickerAction {
  key: "swap" | "deposit" | "spot" | "perp" | "status" | "withdraw";
  label: string;
}

async function runInteractive(json: boolean): Promise<void> {
  const actions: PickerAction[] = [
    { key: "swap", label: "Swap tokens (same-chain or cross-chain)" },
    { key: "deposit", label: "Deposit USDC into Hyperliquid" },
    { key: "spot", label: "Hyperliquid spot order" },
    { key: "perp", label: "Hyperliquid perp (long/short)" },
    { key: "status", label: "Check Hyperliquid account status" },
    { key: "withdraw", label: "Withdraw USDC from Hyperliquid" },
  ];
  const choice = await selectOption("What would you like to do?", actions, (a) => a.label);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    switch (choice.key) {
      case "status":
        await runStatus(json);
        return;
      case "withdraw": {
        const amountIn = await ask(rl, "USDC amount to withdraw: ");
        const recipient = await ask(rl, "Destination (blank = your wallet): ");
        await runWithdraw(amountIn, recipient || undefined, json);
        return;
      }
      case "perp": {
        const token = await ask(rl, "Token (e.g. BTC): ");
        const side = await ask(rl, "Side (long/short): ");
        const size = await ask(rl, "Size (token units): ");
        const price = await ask(rl, "Limit price (blank = market): ");
        const leverage = await ask(rl, "Leverage (blank = leave as-is): ");
        await runPerp(
          { token, side, size, price: price || undefined, leverage: leverage || undefined },
          json
        );
        return;
      }
      case "spot": {
        const dir = await ask(rl, "Buy or sell? ");
        const token = await ask(rl, "Token (e.g. PURR): ");
        const buying = dir.trim().toLowerCase().startsWith("b");
        const amountIn = await ask(
          rl,
          buying ? "USDC to spend: " : `${token} amount to sell: `
        );
        const price = await ask(rl, "Limit price (blank = market): ");
        await runHlSpot(
          {
            tokenIn: buying ? "usdc" : token,
            tokenOut: buying ? token : "usdc",
            amountIn,
            price: price || undefined,
          },
          json
        );
        return;
      }
      case "deposit": {
        const amountIn = await ask(rl, `USDC amount to deposit (min ${MIN_DEPOSIT_USDC}): `);
        const chainIn = await ask(rl, `Source chain ID (blank = ${DEFAULT_FROM_CHAIN}): `);
        await runSwap(
          { amountIn, chainIn: chainIn || undefined, chainOut: HL_CHAIN_ID },
          json
        );
        return;
      }
      case "swap": {
        const tokenIn = await ask(rl, "Token in (symbol or address): ");
        const chainIn = await ask(rl, "Chain in (ID): ");
        const amountIn = await ask(rl, "Amount in (human units): ");
        const tokenOut = await ask(rl, "Token out (symbol or address): ");
        const chainOut = await ask(rl, "Chain out (ID): ");
        await runSwap({ tokenIn, chainIn, amountIn, tokenOut, chainOut }, json);
        return;
      }
    }
  } finally {
    rl.close();
  }
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return prompt(rl, q).then((s) => s.trim());
}

// ---------- HTTP + shared helpers ----------

async function post<T>(
  baseUrl: string,
  token: string,
  path: string,
  body: unknown
): Promise<T> {
  const base = baseUrl.replace(/\/$/, "");
  // Calldata to sign flows back over this connection, so refuse plaintext: a
  // downgraded/MITM'd hop could feed the signer malicious transactions.
  if (!/^https:\/\//i.test(base)) {
    throw new CliError(
      `Refusing to call a non-https trade endpoint: ${base}`,
      "VALIDATION_ERROR",
      "The ACP API base URL must be https://."
    );
  }
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Read the body once as text, then try to parse it. Calling res.json()
    // first consumes the stream, so a non-JSON error body would make a
    // follow-up res.text() throw "body already used" and mask the real error.
    const raw = await res.text();
    let parsed: { error?: string; code?: string; recovery?: string } | string;
    try {
      parsed = JSON.parse(raw) as { error?: string; code?: string; recovery?: string };
    } catch {
      parsed = raw;
    }
    const message =
      typeof parsed === "string"
        ? `${res.status} ${res.statusText}: ${parsed}`
        : `${res.status} ${res.statusText}: ${parsed.error ?? "unknown"}`;
    const code =
      typeof parsed === "object" && parsed.code ? parsed.code : `HTTP_${res.status}`;
    const recovery = typeof parsed === "object" ? parsed.recovery : undefined;
    throw new CliError(message, isKnownCode(code) ? code : "API_ERROR", recovery);
  }
  return (await res.json()) as T;
}

function parsePerpSide(side: string): boolean {
  const s = side.trim().toLowerCase();
  if (s === "long") return true;
  if (s === "short") return false;
  throw new CliError(
    `Invalid --side: ${side || "(empty)"}`,
    "VALIDATION_ERROR",
    "Use long or short for a perp."
  );
}

function parseSlippage(pct: string): number {
  const n = Number(pct);
  if (!Number.isFinite(n) || n < 0 || n >= 100) {
    throw new CliError(
      `Invalid --slippage: ${pct}`,
      "VALIDATION_ERROR",
      "Pass a percent between 0 and 100, e.g. 5."
    );
  }
  return n / 100;
}

function summarizeOrder(res: {
  response: { data: { statuses: unknown[] } };
}): Record<string, unknown> {
  const statuses = res.response?.data?.statuses ?? [];
  return { status: "ok", statuses };
}

const KNOWN_CODES = new Set<string>([
  "NOT_AUTHENTICATED",
  "NO_ACTIVE_AGENT",
  "NO_SIGNER",
  "SESSION_NOT_FOUND",
  "VALIDATION_ERROR",
  "API_ERROR",
  "ALREADY_EXISTS",
  "TIMEOUT",
  "SLIPPAGE_TOO_LOW",
  "INSUFFICIENT_GAS",
]);

function isKnownCode(s: string): s is ErrorCode {
  return KNOWN_CODES.has(s);
}

function progress(json: boolean, msg: string): void {
  if (json || !isTTY()) return;
  process.stderr.write(`${msg}\n`);
}

// @nktkas/hyperliquid's `exchange.order()` leaves a transport handle open, so
// the process won't exit on its own after a perp/spot order (swap, deposit,
// withdraw, and status all exit fine — only order() is affected). The result
// has already been printed; give stdout a tick to flush, then exit explicitly.
// The timer is unref'd so it never blocks a natural exit.
function exitAfterOrder(): void {
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
}

// Place an HL order with a hard timeout and a guaranteed exit. Two SDK quirks
// are handled here: (1) a successful order() leaves a transport handle open
// (see exitAfterOrder); (2) a rejected/invalid order() can hang forever without
// resolving — so we race it against a timeout. Either way the process exits.
async function placeHlOrder(
  exchange: HlExchange,
  order: Parameters<HlExchange["order"]>[0],
  json: boolean
): Promise<void> {
  try {
    const res = await Promise.race([
      exchange.order(order),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new CliError(
                "Hyperliquid did not respond to the order in time — run `acp trade status` to check whether it placed.",
                "TIMEOUT"
              )
            ),
          20_000
        ).unref()
      ),
    ]);
    outputResult(json, summarizeOrder(res));
  } catch (err) {
    outputError(json, err instanceof Error ? err : String(err));
  } finally {
    exitAfterOrder();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
