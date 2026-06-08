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
// How it works: `acp trade` forwards every flag it was given to the ACP backend
// (/trade/plan + /trade/next, same bearer auth as every other command). The
// backend — NOT the CLI — detects the venue from those flags and drives the
// flow; the server builds each action (calldata or EIP-712), and the CLI only
// signs + broadcasts with the keystore signer (no human prompt). HL perp/spot/
// withdraw included: they're EIP-712 actions the backend builds and the CLI
// signs. The CLI does zero routing. Private keys never leave the keystore.
// (Only `acp trade status` is a direct read-only HL query.)
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
// HL trading now runs entirely through the backend `/trade/plan` loop; only the
// read-only account status still talks to Hyperliquid directly (InfoClient).
import { createHlInfoClient, isTestnet } from "../lib/hl/client";

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
        await runTrade(opts, json);
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
  // Convenience alias for moving USDC off Hyperliquid. No special logic — it
  // just forwards the equivalent flat request (chain-in 1337 → chain-out) and
  // the backend detects the withdraw, same as everything else.
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
        await runTrade(
          {
            chainIn: 1337,
            chainOut: opts.toChain ?? 42161,
            amountIn: opts.amount,
            recipient: opts.destination,
            dryRun: opts.dryRun,
          },
          json
        );
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}

// One trade path: forward every provided flag verbatim to the backend, which
// detects the venue (swap / deposit / HL spot / HL perp / HL withdraw /
// Treasures) and hands back the actions to sign. The CLI does no routing.
async function runTrade(opts: Record<string, unknown>, json: boolean): Promise<void> {
  const { apiUrl, token } = await getApiContext();
  const owner = getWalletAddress() as Address;
  const provider = await createProviderAdapter();

  const body: Record<string, unknown> = { walletAddress: owner };
  const fwd = (key: string, v: unknown) => {
    if (v !== undefined) body[key] = v;
  };
  fwd("tokenIn", opts.tokenIn);
  fwd("chainIn", opts.chainIn);
  fwd("amountIn", opts.amountIn);
  fwd("tokenOut", opts.tokenOut);
  fwd("chainOut", opts.chainOut);
  fwd("recipient", opts.recipient);
  fwd("slippage", opts.slippage); // percent; backend converts to bps
  fwd("deadlineSecs", opts.deadlineSecs);
  fwd("token", opts.token);
  fwd("side", opts.side);
  fwd("size", opts.size);
  fwd("leverage", opts.leverage);
  fwd("price", opts.price);
  fwd("amountUsdc", opts.amountUsdc);
  fwd("amountShares", opts.amountShares);
  fwd("protocol", opts.protocol);
  fwd("chain", opts.chain);
  if (opts.postOnly) body.postOnly = true;
  if (opts.reduceOnly) body.reduceOnly = true;
  if (opts.isolated) body.isolated = true;
  if (opts.dryRun) body.dryRun = true;

  const plan: PlanResponse = await post(apiUrl, token, "/trade/plan", body);
  progress(
    json,
    `Trade ${plan.tradeId.slice(0, 8)}` +
      (plan.direction && plan.route ? ` (${plan.direction} via ${plan.route})` : "")
  );
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
