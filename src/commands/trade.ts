// `acp trade` — one command for moving and trading value. The chains you pass
// decide the venue: Hyperliquid is chain 1337, so swaps, HL deposits, HL spot,
// and HL withdrawals all share the same --token-in/--chain-in/--amount-in/
// --token-out/--chain-out shape. Only perps are different (a leveraged position,
// not a token conversion), so they use --side long|short.
//
// ── Intent routing (for LLM agents and humans) ──────────────────────────────
//   --side long|short                         → Hyperliquid PERP (leveraged)
//   --chain-in 1337  --chain-out 1337         → Hyperliquid SPOT (order book)
//   --chain-in <evm> --chain-out 1337         → DEPOSIT USDC into Hyperliquid
//   --chain-in 1337  --chain-out <evm>        → WITHDRAW USDC from Hyperliquid
//   --chain-in <evm> --chain-out <evm>        → SWAP (DEX: BondingV5 / LiFi)
//   (no flags, in a terminal)                 → interactive picker (humans only)
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
import {
  buildChallenge as buildTreasuresChallenge,
  quoteBuy as treasuresQuoteBuy,
  quoteSell as treasuresQuoteSell,
  quoteStatus as treasuresQuoteStatus,
  tradeSubmit as treasuresTradeSubmit,
  type QuoteLeg as TreasuresQuoteLeg,
  type QuoteResponse as TreasuresQuoteResponse,
  type SignedLeg as TreasuresSignedLeg,
  type SignedPayload as TreasuresSignedPayload,
  type QuoteStatusResponse as TreasuresQuoteStatusResponse,
} from "../lib/treasures/client";

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
type Action = SendAction | WaitAction | DoneAction | ErrorAction;

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
        "  --side long|short                     → Hyperliquid perp (leveraged; crypto, stocks, FX, commodities)\n" +
        "  (no flags, in a terminal)             → interactive picker\n" +
        "\nExamples:\n" +
        "  acp trade --token-in usdc --chain-in 8453 --amount-in 50 --token-out virtual --chain-out 8453\n" +
        "  acp trade --token-in usdc --chain-in 1 --amount-in 100 --token-out usdc --chain-out 8453\n" +
        "  acp trade --token-in usdc --chain-in 8453 --amount-in 25 --token-out usdc --chain-out 1337   # deposit\n" +
        "  acp trade --token-in usdc --chain-in 1337 --amount-in 100 --token-out PURR --chain-out 1337  # spot buy\n" +
        "  acp trade --token-in PURR --chain-in 1337 --amount-in 50 --token-out usdc --chain-out 1337   # spot sell\n" +
        "  acp trade --token-in usdc --chain-in 1337 --amount-in 25 --token-out usdc --chain-out 42161  # withdraw\n" +
        "  acp trade --side long --token BTC --size 0.01 --leverage 5\n" +
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
    .option("--ticker <symbol>", "Tokenized stock ticker, e.g. AAPL (routes via Treasures)")
    .option("--amount-usdc <amount>", "USDC to spend on a Treasures buy")
    .option("--amount-shares <amount>", "Shares to liquidate on a Treasures sell")
    .option("--protocol <name>", "Treasures protocol filter: ondo or xstocks")
    .option("--chain <name>", "Treasures chain filter: sol or eth")
    // -- Hyperliquid perp (position shape) -------------------------------
    .option("--side <side>", "Perp side: long or short")
    .option("--token <symbol>", "Perp market symbol — crypto, equity/stock, FX, or commodity (e.g. BTC, ETH, SOL)")
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

function detectIntent(opts: Record<string, unknown>, json: boolean): Intent {
  // --ticker is the unambiguous Treasures (tokenized stock) signal. It wins
  // over every other route — none of the swap/HL flags carry stock tickers,
  // so seeing one means the user wants `/quote/buy` or `/quote/sell` and
  // nothing else can match. Treasures fills settle a tokenized stock token
  // into the wallet (not a position), so it sits next to swaps shape-wise.
  if (opts.ticker !== undefined) return "treasures-stock";

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

async function runTradeLoop(
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

// Treasures EVM legs settle on Ethereum mainnet — the stock-token ERC-20s
// (Ondo's <TICKER>on, Backed's <TICKER>x) are deployed there, not on Base
// or any other L2. The Fusion order's EIP-712 domain.chainId is the source
// of truth for what we sign, but we expose this constant so error messages
// and helpers can reason about "the chain Treasures eth-legs live on".
const TREASURES_ETH_CHAIN_ID = 1;
// EIP-191 personal_sign is chain-agnostic by construction (no EIP-155 chain
// binding), so the chainId we hand the provider for the ownership-proof
// challenge is only used to pick which keystore client to call. Anything the
// adapter supports works. We use Base to match `acp wallet sign-message`'s
// default and avoid forcing a mainnet-chain wiring just to sign a string.
const TREASURES_PROOF_CHAIN_ID = 8453;
// Default slippage if --slippage-bps isn't passed. 300 bps (3%) is realistic
// for liquid AAPL/MSFT-style names; thinner tickers can need 500-1000+.
const DEFAULT_TREASURES_SLIPPAGE_BPS = 300;
// Status poll cadence + timeout. Most Fusion fills land in 5-20s; Ondo's
// settlement window can stretch closer to a minute. 120s gives all-or-nothing
// resolution before we hand the caller a TIMEOUT to retry status manually.
const TREASURES_POLL_MS = 3000;
const TREASURES_POLL_TIMEOUT_MS = 120_000;

async function runTreasuresStock(
  opts: Record<string, unknown>,
  json: boolean
): Promise<void> {
  const ticker = String(opts.ticker).trim().toUpperCase();
  const amountUsdc =
    opts.amountUsdc !== undefined ? String(opts.amountUsdc) : undefined;
  const amountShares =
    opts.amountShares !== undefined ? String(opts.amountShares) : undefined;

  // Direction = which amount field you set. Requiring exactly one keeps the
  // routing unambiguous: --amount-usdc means "spend this much USDC", which
  // can only be a buy; --amount-shares means "sell this many shares", which
  // can only be a sell. Sharing --amount-in across both would force a separate
  // --side flag (and --side is already perp-only).
  if ((amountUsdc !== undefined) === (amountShares !== undefined)) {
    throw new CliError(
      "Treasures needs exactly one of --amount-usdc (buy) or --amount-shares (sell).",
      "VALIDATION_ERROR",
      "e.g. `acp trade --ticker AAPL --amount-usdc 50` (buy) or " +
        "`acp trade --ticker AAPL --amount-shares 0.1` (sell)."
    );
  }
  const isBuy = amountUsdc !== undefined;

  const slippageBps =
    opts.slippageBps !== undefined
      ? parseTreasuresSlippageBps(opts.slippageBps)
      : DEFAULT_TREASURES_SLIPPAGE_BPS;
  const protocol =
    opts.protocol !== undefined
      ? validateTreasuresProtocol(String(opts.protocol))
      : undefined;
  const chainFilter =
    opts.chain !== undefined
      ? validateTreasuresChain(String(opts.chain))
      : undefined;

  const owner = getWalletAddress() as Address;
  const ethWallet = owner.toLowerCase() as Address;
  const provider = await createProviderAdapter();

  // 1) Sign the ownership-proof canonical challenge. We use the EVM signer
  // only — Sol legs aren't submittable from this CLI yet. The challenge
  // includes an empty sol_wallet line, which the server hashes; if we later
  // add Sol signing we'll also need to send sol_wallet in the request body.
  const issuedAt = Math.floor(Date.now() / 1000);
  const challenge = buildTreasuresChallenge({ issuedAt, ethWallet });
  progress(json, `Signing Treasures ownership proof (issued_at=${issuedAt})`);
  const ethSig = await provider.signMessage(TREASURES_PROOF_CHAIN_ID, challenge);

  // 2) Request a quote. The server returns up to N signable legs; for a buy
  // it's at most 2 (one per chain, best first), for a sell it can be more
  // (every leg the planner needs across the holding to liquidate the requested
  // share amount). Either way we sign and submit all of them.
  const baseQuoteReq = {
    ticker,
    max_slippage_bps: slippageBps,
    eth_wallet: ethWallet,
    ownership_proof: { eth_signature: ethSig, issued_at: issuedAt },
    ...(protocol ? { protocol } : {}),
    ...(chainFilter ? { chain: chainFilter } : {}),
  };
  progress(
    json,
    isBuy
      ? `Requesting buy quote: ${ticker} for ${amountUsdc} USDC @ ${slippageBps}bps`
      : `Requesting sell quote: ${amountShares} ${ticker} shares @ ${slippageBps}bps`
  );
  const quote: TreasuresQuoteResponse = isBuy
    ? await treasuresQuoteBuy({ ...baseQuoteReq, amount_usdc: amountUsdc! })
    : await treasuresQuoteSell({ ...baseQuoteReq, amount_shares: amountShares! });

  if (quote.quotes.length === 0) {
    throw new CliError(
      `Treasures returned no legs for ${ticker}.`,
      "API_ERROR",
      "Try a higher --slippage-bps or a different --protocol / --chain."
    );
  }
  progress(
    json,
    `Got quote ${quote.quote_id} (${quote.quotes.length} leg${quote.quotes.length === 1 ? "" : "s"}, expires_at=${quote.expires_at})`
  );

  // 3) Sign every leg. EVM legs are 1inch Fusion EIP-712 orders bound to
  // mainnet (domain.chainId=1); we honor whatever the server returns rather
  // than hard-coding 1, since a future Treasures expansion to other EVM
  // chains would just change the domain. Sol legs need Ed25519 over the
  // serialized VersionedTransaction — the current CLI keystore doesn't sign
  // Sol payloads, so we fail loudly rather than silently dropping the leg
  // (which would 400 on submit with `incomplete_submit` anyway).
  const signedLegs: TreasuresSignedLeg[] = [];
  for (const leg of quote.quotes) {
    const signedPayloads = await Promise.all(
      leg.signable_payloads.map((payload) =>
        signTreasuresPayload(provider, leg, payload)
      )
    );
    signedLegs.push({ quote_index: leg.quote_index, signed_payloads: signedPayloads });
  }
  progress(json, `Signed ${signedLegs.length} leg${signedLegs.length === 1 ? "" : "s"}, submitting`);

  // 4) Submit atomically. The server is idempotent on (quote_id, quote_index),
  // so a network retry of /trade/submit won't double-broadcast. If the quote's
  // snapshot expired between issue and submit we get 410 quote_stale — the
  // user just re-runs the command (we don't retry transparently because the
  // re-quote may come back with different legs/prices the user should see).
  const submitRes = await treasuresTradeSubmit({
    quote_id: quote.quote_id,
    signed: signedLegs,
  });

  // 5) Poll status until terminal. /trade/submit returns optimistically once
  // each leg is broadcast (or queued for broadcast); the on-chain fill lands
  // asynchronously. Polling is the only way to see the final filled_shares /
  // filled_usdc and any per-leg failures.
  progress(json, `Polling ${quote.quote_id} for fill`);
  const finalStatus = await pollTreasuresStatus(quote.quote_id, json);

  outputResult(json, {
    quote_id: quote.quote_id,
    side: isBuy ? "buy" : "sell",
    ticker,
    aggregate_status: finalStatus.aggregate_status,
    submit: submitRes,
    legs: finalStatus.legs,
  });

  // `completed` is the only success; pollTreasuresStatus only returns terminal
  // states, so anything else here is `partial_failed`/`all_failed`. The per-leg
  // detail was just printed above — flip the exit code (rather than throw and
  // re-print via the error path) so scripts can branch on a non-zero exit.
  if (finalStatus.aggregate_status !== "completed") {
    process.exitCode = 1;
    progress(
      json,
      `Treasures quote ${quote.quote_id} ended ${finalStatus.aggregate_status}`
    );
  }
}

async function signTreasuresPayload(
  provider: IEvmProviderAdapter,
  leg: TreasuresQuoteLeg,
  payload: TreasuresQuoteLeg["signable_payloads"][number]
): Promise<TreasuresSignedPayload> {
  if (payload.type === "evm_eip712_typed_data") {
    const signature = await provider.signTypedData(
      Number(payload.typed_data.domain.chainId),
      payload.typed_data
    );
    return { type: "evm_eip712_signature", signature };
  }
  // Sol path: we'd need to deserialize the VersionedTransaction, Ed25519-sign
  // the message bytes with the agent's Sol keypair, splice the signature into
  // the tx, and re-serialize as base64. The CLI keystore is EVM-only today,
  // so refuse rather than half-submit.
  throw new CliError(
    `Treasures returned a ${payload.type} leg (chain=${leg.chain}); ` +
      "the CLI keystore can't sign Solana payloads yet.",
    "VALIDATION_ERROR",
    "Filter to EVM-only with `--chain eth`, or sign and submit Sol legs out-of-band."
  );
}

async function pollTreasuresStatus(
  quoteId: string,
  json: boolean
): Promise<TreasuresQuoteStatusResponse> {
  const deadline = Date.now() + TREASURES_POLL_TIMEOUT_MS;
  let lastAgg: string | undefined;
  for (;;) {
    const s = await treasuresQuoteStatus(quoteId);
    if (s.aggregate_status !== "in_progress") return s;
    if (s.aggregate_status !== lastAgg) {
      progress(json, `  status=${s.aggregate_status} (cached=${s.is_cached})`);
      lastAgg = s.aggregate_status;
    }
    // Stop only *after* a fresh check, so a fill that lands during the final
    // sleep is still observed rather than misreported as a TIMEOUT.
    if (Date.now() >= deadline) break;
    await sleep(TREASURES_POLL_MS);
  }
  throw new CliError(
    `Treasures quote ${quoteId} did not reach a terminal status within ${TREASURES_POLL_TIMEOUT_MS / 1000}s.`,
    "TIMEOUT",
    `Re-check later via GET /quote/${quoteId}/status (no auth required).`
  );
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
