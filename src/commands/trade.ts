// `acp trade` — one command for moving and trading value. The chains you pass
// decide the venue: Hyperliquid is chain 1337, so swaps, HL deposits, and HL
// spot all share the same --token-in/--chain-in/--amount-in/--token-out/
// --chain-out shape. Perps are different (a leveraged position, not a token
// conversion), so they use --side long|short. Withdrawing USDC off Hyperliquid
// is its own subcommand (`withdraw-from-hl`) — it always settles to Arbitrum,
// so it isn't a chain choice and doesn't fit the token-pair shape.
//
// ── Intent routing (for LLM agents and humans) ──────────────────────────────
//   --token <sym> --side long|short           → Hyperliquid PERP (leveraged)
//   --token <sym> --amount-usdc|--amount-shares → Treasures TOKENIZED STOCK (spot)
//   --chain-in 1337  --chain-out 1337         → Hyperliquid SPOT (order book)
//   --chain-in <evm> --chain-out 1337         → DEPOSIT USDC into Hyperliquid
//   --chain-in 1337  --chain-out <evm>        → WITHDRAW off Hyperliquid (Arbitrum direct; others bridge onward)
//   --chain-in <evm> --chain-out <evm>        → SWAP (DEX: BondingV5 / LiFi)
// Canonical way to move USDC OFF Hyperliquid: `acp trade withdraw-from-hl
// --amount <usdc> [--to-chain <id>]`. HL's withdraw3 always settles to Arbitrum;
// a non-Arbitrum target withdraws to Arbitrum first, then bridges onward.
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
import { isJson, isTTY, outputError, outputResult } from "../lib/output";
import { CliError, type ErrorCode } from "../lib/errors";
import { getApiContext } from "../lib/api/client";
import {
  createProviderAdapter,
  getWalletAddress,
} from "../lib/agentFactory";
import type { IEvmProviderAdapter } from "@virtuals-protocol/acp-node-v2";
import { parseChainArg } from "../lib/chains";
// HL trading now runs entirely through the backend `/trade/plan` loop; only the
// read-only account status still talks to Hyperliquid directly (InfoClient).
import { createHlInfoClient, isTestnet } from "../lib/hl/client";
// LiFi's chain id for Hyperliquid Core (the perps/spot collateral ledger).
// Any leg whose chain is this is "on Hyperliquid".
const HL_CHAIN_ID = 1337;
// Hyperliquid's withdraw3 always settles USDC on Arbitrum — the only chain a
// withdraw can land on, and the one the `--chain-in 1337 --chain-out 42161`
// compat form is allowed to target.
const HL_WITHDRAW_CHAIN_ID = 42161;
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
// Returned by /trade/plan only for a dry run (dryRun: true) — nothing is signed
// or submitted. Mirrors trading-agent's PreviewAction.
interface PreviewAction {
  kind: "preview";
  label: string;
  summary: string;
  legs?: unknown[];
}
type Action =
  | SendAction
  | SignAction
  | WaitAction
  | DoneAction
  | ErrorAction
  | PreviewAction;

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
      "Buy, sell, swap tokens or trade perps — across any chain. " +
      "Cross-chain is always supported: your funds can be on Ethereum, Arbitrum, or Base " +
      "and the CLI will bridge them automatically. " +
      "Hyperliquid (chain 1337) — " +
        "deposits, spot orders, withdrawals, and perps. Routes by the chains/params " +
        "you pass. See `acp trade --help`."
    )
    .addHelpText(
      "after",
      "\nSupported chains (pass the id or the name — names are case-insensitive):\n" +
        "  1       Ethereum     (eth, ethereum, mainnet)\n" +
        "  42161   Arbitrum     (arb, arbitrum)\n" +
        "  8453    Base         (base) (default)\n" +
        "  1337    Hyperliquid  (hl, hyperliquid)\n" +
        "\nYour funds can be on any supported chain — cross-chain bridging is handled automatically.\n" +
        "\nHow chains map to venues:\n" +
        "  --chain-in <evm>  --chain-out <evm>   → DEX swap (bridges cross-chain if needed)\n" +
        "  --chain-in <evm>  --chain-out 1337    → deposit USDC into Hyperliquid\n" +
        "  --chain-in 1337   --chain-out 1337    → Hyperliquid spot order\n" +
        "  --chain-in 1337   --chain-out <evm>   → withdraw USDC off Hyperliquid (Arbitrum direct; other chains bridge onward)\n" +
        "\nNote: --amount-in is what you spend, not what you receive.\n" +
        "  e.g. --amount-in 10 spends $10 USDC — the output amount depends on the current price.\n" +
        "  --token <sym> --side long|short --size <n> --leverage <n>  → Hyperliquid perp\n" +
        "    --size is in TOKEN UNITS, not USD (e.g. --size 0.01 = 0.01 BTC). --leverage reduces margin required.\n" +
        "\nAdd --dry-run to any trade to preview the route, size, margin, and fees without signing or submitting.\n" +
        "  --token <sym> --amount-usdc|-shares   → Treasures tokenized stock (spot buy/sell, USDC on Ethereum)\n" +
        "  --token <sym> --token-in/-chain-in/-amount-in (no --token-out) → Treasures buy funded from any chain\n" +
        "\nExamples:\n" +
        "  acp trade --token-in usdc --chain-in 8453 --amount-in 50 --token-out virtual --chain-out 8453\n" +
        "  acp trade --token-in usdc --chain-in 1 --amount-in 100 --token-out usdc --chain-out 8453\n" +
        "  acp trade --token-in usdc --chain-in 8453 --amount-in 25 --token-out usdc --chain-out 1337   # deposit\n" +
        "  acp trade --token-in usdc --chain-in 1337 --amount-in 100 --token-out PURR --chain-out 1337  # spot buy\n" +
        "  acp trade --token-in PURR --chain-in 1337 --amount-in 50 --token-out usdc --chain-out 1337   # spot sell\n" +
        "  acp trade withdraw-from-hl --amount 25                                                       # withdraw to Arbitrum\n" +
        "  acp trade --side long --token BTC --size 0.01 --leverage 5\n" +
        "  acp trade --side long --token BTC --size 0.01 --leverage 5 --dry-run   # preview only\n" +
        "  acp trade --amount-in 25 --chain-out hyperliquid                       # deposit (alias)\n" +
        "  acp trade --token AAPL --amount-usdc 50                          # buy tokenized AAPL with USDC on Ethereum\n" +
        "  acp trade --token AAPL --token-in eth --chain-in 8453 --amount-in 0.02  # buy AAPL, funded by ETH on Base\n" +
        "  acp trade --token AAPL --amount-shares 0.1                       # sell 0.1 tokenized AAPL shares (Treasures)\n" +
        "  acp trade status\n"
    )
    // -- Swap / deposit / HL spot / HL withdraw (token-pair shape) --------
    .option("--token-in <token>", "Input token (address or symbol)")
    .option("--chain-in <id>", "Input chain ID — 1 (Ethereum), 42161 (Arbitrum), 8453 (Base), 1337 (Hyperliquid). Cross-chain bridging is automatic.")
    .option("--amount-in <amount>", "Input amount in human units (USDC for an HL spot buy)")
    .option("--token-out <token>", "Output token (address or symbol)")
    .option("--chain-out <id>", "Output chain ID — 1 (Ethereum), 42161 (Arbitrum), 8453 (Base), 1337 (Hyperliquid).")
    .option("--recipient <addr>", "Output recipient (default: active wallet)")
    .option("--deadline-secs <secs>", "BondingV5 deadline in seconds")
    .option("--price <price>", "HL spot limit price (omit for a market order)")
    .option("--post-only", "HL post-only (Alo) limit order; rejects if it crosses", false)
    .option("--slippage <pct>", "Max slippage as a percent, e.g. 5 = 5% (HL orders default to 5%; swaps/Treasures use the server default if omitted)")
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
    .option("--dry-run", "Preview the trade (route, size, margin, fees) without signing or submitting anything", false)
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        // Normalize chain aliases (e.g. "hyperliquid", "arb") to numeric ids up
        // front, so intent routing and the chain comparisons below all see a
        // number — and the backend receives a clean id too.
        if (opts.chainIn !== undefined) opts.chainIn = parseChainArg(opts.chainIn as string | number);
        if (opts.chainOut !== undefined) opts.chainOut = parseChainArg(opts.chainOut as string | number);
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
            // Compat form: `--chain-in 1337 --chain-out <id> --amount-in <n>`.
            // --chain-out 42161 (or omitted) withdraws straight to Arbitrum;
            // any other chain withdraws to Arbitrum then bridges onward.
            await runWithdraw(
              String(opts.amountIn),
              opts.recipient as string | undefined,
              json,
              opts.dryRun === true,
              opts.chainOut !== undefined
                ? Number(opts.chainOut)
                : HL_WITHDRAW_CHAIN_ID
            );
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

  // ── withdraw-from-hl ────────────────────────────────────────────────────────
  // The ONLY way to move USDC off Hyperliquid. It's its own command (not a
  // chain-in/chain-out combo) because it isn't a swap or a chain choice:
  // HL's withdraw3 always settles USDC on Arbitrum, full stop.
  trade
    .command("withdraw-from-hl")
    .description("Withdraw USDC from Hyperliquid (settles to Arbitrum; --to-chain bridges onward)")
    .requiredOption("--amount <usdc>", "USDC amount to withdraw")
    .option("--destination <addr>", "Destination address (default: active wallet)")
    .option("--to-chain <id>", "Final chain (default: Arbitrum). Others withdraw to Arbitrum, then bridge.")
    .option("--dry-run", "Preview the withdrawal without submitting it", false)
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        await runWithdraw(
          String(opts.amount),
          opts.destination,
          json,
          opts.dryRun === true,
          opts.toChain !== undefined
            ? parseChainArg(opts.toChain as string | number)
            : HL_WITHDRAW_CHAIN_ID
        );
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
  | "swap";

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
      // A non-USDC token-out is clearly a spot order that just forgot
      // `--chain-out 1337` — don't silently treat it as a withdraw and move
      // funds off Hyperliquid.
      const tOut = opts.tokenOut !== undefined ? String(opts.tokenOut) : undefined;
      if (tOut && !isUsdcSymbol(tOut)) {
        throw new CliError(
          "A Hyperliquid spot order needs --chain-out 1337.",
          "VALIDATION_ERROR",
          `e.g. --token-in usdc --chain-in 1337 --amount-in 100 --token-out ${tOut} --chain-out 1337.`
        );
      }
      // Otherwise chain-in 1337 is a withdraw off Hyperliquid. Destination
      // defaults to Arbitrum (where HL settles); any other --chain-out withdraws
      // to Arbitrum first, then bridges onward. `withdraw-from-hl` is the
      // canonical command; this combo is kept working for existing callers.
      return "withdraw";
    }
    if (outHL) return "deposit";
    return "swap";
  }

  // Bare --token with no pair params (an incomplete perp) → perp path, which
  // surfaces a clear "--side is required" error.
  if (opts.token !== undefined) return "perp";

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
    slippageBps: opts.slippage !== undefined ? slippageBpsFromPct(String(opts.slippage)) : undefined,
    deadlineSecs: opts.deadlineSecs !== undefined ? Number(opts.deadlineSecs) : undefined,
    recipient: (opts.recipient as string | undefined) ?? (isDeposit ? owner : undefined),
    walletAddress: owner,
    ...(opts.dryRun ? { dryRun: true } : {}),
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
  outputTradeResult(json, result);
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
    if (action.kind === "preview") {
      // Dry run: server resolved + sized the trade but signed/submitted nothing.
      return {
        dryRun: true,
        summary: action.summary,
        ...(action.legs ? { legs: action.legs } : {}),
      };
    }
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
      "One side of a spot order must be USDC.",
      "VALIDATION_ERROR",
      "To buy: --token-in usdc --token-out PURR. To sell: --token-in PURR --token-out usdc."
    );
  }
  // Buy when the output is the token (spending USDC); sell when the input is the token.
  const isBuy = !outUsdc;
  const coin = isBuy ? tokenOut : tokenIn;

  // The backend builds + sizes the order and hands back an EIP-712 `sign` action.
  const hlSpot: Record<string, unknown> = {
    coin,
    side: isBuy ? "buy" : "sell",
    // A buy spends amount-in USDC; a sell sells amount-in token units.
    ...(isBuy ? { amountUsdc: String(opts.amountIn) } : { size: String(opts.amountIn) }),
    ...(opts.price !== undefined ? { price: String(opts.price) } : {}),
    ...(opts.postOnly ? { postOnly: true } : {}),
    ...(opts.slippage !== undefined
      ? { slippageBps: slippageBpsFromPct(String(opts.slippage)) }
      : {}),
  };

  const { apiUrl, token } = await getApiContext();
  const owner = getWalletAddress() as Address;
  const provider = await createProviderAdapter();
  const plan: PlanResponse = await post(apiUrl, token, "/trade/plan", {
    walletAddress: owner,
    hlSpot,
    ...(opts.dryRun ? { dryRun: true } : {}),
  });
  progress(
    json,
    `HL spot ${plan.tradeId.slice(0, 8)} — ${isBuy ? "buy" : "sell"} ${coin}`
  );
  const result = await runTradeLoop(apiUrl, token, provider, plan, json);
  outputTradeResult(json, result);
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
    throw new CliError(
      "--size is required for a perp (token units).",
      "VALIDATION_ERROR",
      "e.g. `--token BTC --side long --size 0.01 --leverage 5`. Size is in token units, not USD."
    );
  }
  // The backend sizes the order, pins/adopts leverage, auto-balances spot→perp,
  // and returns an EIP-712 `sign` action; the CLI just signs the loop.
  const hl: Record<string, unknown> = {
    coin: String(opts.token),
    side: String(opts.side).toLowerCase(), // long | short (validated in detectIntent)
    size: String(opts.size),
    ...(opts.leverage !== undefined ? { leverage: Number(opts.leverage) } : {}),
    ...(opts.slippage !== undefined
      ? { slippageBps: slippageBpsFromPct(String(opts.slippage)) }
      : {}),
    ...(opts.price !== undefined ? { price: String(opts.price) } : {}),
    ...(opts.postOnly ? { postOnly: true } : {}),
    ...(opts.reduceOnly ? { reduceOnly: true } : {}),
    ...(opts.isolated ? { isolated: true } : {}),
  };

  const { apiUrl, token } = await getApiContext();
  const owner = getWalletAddress() as Address;
  const provider = await createProviderAdapter();
  const plan: PlanResponse = await post(apiUrl, token, "/trade/plan", {
    walletAddress: owner,
    hl,
    ...(opts.dryRun ? { dryRun: true } : {}),
  });
  progress(
    json,
    `HL perp ${plan.tradeId.slice(0, 8)} — ${String(opts.side)} ${String(opts.token)}`
  );
  const result = await runTradeLoop(apiUrl, token, provider, plan, json);
  outputTradeResult(json, result);
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

// Withdraw USDC off Hyperliquid via the backend planner. HL's withdraw3 always
// settles to Arbitrum; a non-Arbitrum destChain tells the backend to withdraw to
// Arbitrum, wait for settlement, then bridge onward (it drives the wait+bridge
// through the same /trade/next loop). The CLI just signs.
async function runWithdraw(
  amount: string,
  destination: string | undefined,
  json: boolean,
  dryRun = false,
  destChain: number = HL_WITHDRAW_CHAIN_ID
): Promise<void> {
  if (amount === undefined || amount === "undefined" || amount === "") {
    throw new CliError(
      "--amount is required to withdraw from Hyperliquid.",
      "VALIDATION_ERROR",
      "e.g. `acp trade withdraw-from-hl --amount 25`."
    );
  }
  const hlWithdraw: Record<string, unknown> = {
    amount: String(amount),
    ...(destination ? { destination } : {}),
    ...(destChain !== HL_WITHDRAW_CHAIN_ID ? { toChain: destChain } : {}),
  };

  const { apiUrl, token } = await getApiContext();
  const owner = getWalletAddress() as Address;
  const provider = await createProviderAdapter();
  const plan: PlanResponse = await post(apiUrl, token, "/trade/plan", {
    walletAddress: owner,
    hlWithdraw,
    ...(dryRun ? { dryRun: true } : {}),
  });
  progress(
    json,
    `HL withdraw ${plan.tradeId.slice(0, 8)} — ${amount} USDC → chain ${destChain}`
  );
  const result = await runTradeLoop(apiUrl, token, provider, plan, json);
  outputTradeResult(json, result);
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
    opts.slippage !== undefined
      ? slippageBpsFromPct(String(opts.slippage))
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
    ...(opts.dryRun ? { dryRun: true } : {}),
  });
  progress(
    json,
    `Treasures ${plan.tradeId.slice(0, 8)} — ${String(treasures.side)} ${ticker}` +
      (plan.route ? ` (${plan.route})` : "")
  );
  const result = await runTradeLoop(apiUrl, token, provider, plan, json);
  outputTradeResult(json, result);
}

// Convert a --slippage percent (e.g. "5" = 5%) to basis points for the
// swap/Treasures wire calls. Reuses parseSlippage's validation (which returns a
// 0..1 fraction), so the single --slippage flag covers every route and can't
// serialize to NaN.
function slippageBpsFromPct(raw: string): number {
  return Math.round(parseSlippage(raw) * 10_000);
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

// Render a trade outcome. A dry-run result carries a ready-to-read `summary`, so
// in human mode we print just that (multi-line) string; otherwise (and always
// in --json) we fall back to the structured key/value output.
function outputTradeResult(json: boolean, result: Record<string, unknown>): void {
  if (!json && result.dryRun === true && typeof result.summary === "string") {
    console.log(result.summary);
    return;
  }
  outputResult(json, result);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
