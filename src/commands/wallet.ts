import type { Command } from "commander";
import * as readline from "readline";
import { formatUnits, parseUnits, isAddress, isHex } from "viem";
import {
  buildSolTransferIx,
  buildSplTransferInstructions,
  getSplTokenBalance,
  type ISolanaProviderAdapter,
} from "@virtuals-protocol/acp-node-v2";
import { isJson, outputResult, outputError, isTTY } from "../lib/output";
import { getWalletAddress, getSolanaWalletAddress } from "../lib/agentFactory";
import { getClient } from "../lib/api/client";
import { getAgentId, getActiveWallet } from "../lib/config";
import { CHAIN_NETWORK_MAP } from "../lib/api/agent";
import type {
  AgentAssetsResponse,
  StockPosition,
  TokenInfo,
  HyperliquidBalanceSummary,
  HyperliquidSpotBalance,
  HyperliquidPerpPosition,
} from "../lib/api/agent";
import { CliError } from "../lib/errors";
import {
  assertSponsoredChainId,
  getEnvSponsoredChainIds,
  getNativeCurrency,
  isSolanaChainId,
  solanaChainId,
} from "../lib/chains";
import { c } from "../lib/color";
import { openBrowser } from "../lib/browser";
import { selectOption, prompt } from "../lib/prompt";
import { withApprovalGate } from "../lib/walletGate";
import {
  deserializeSolanaInstructions,
  signSolanaMessage,
  type SerializedSolanaInstruction,
  type SolAddr,
} from "../lib/solana";
import qrcode from "qrcode-terminal";

// Render Treasures tokenized-stock holdings as a table beneath the on-chain
// token list. `usd_value` is precomputed by Treasures, so prefer it; fall back
// to tokens × usd_per_token, and show "—" when neither is available (null means
// "unknown", never 0).
// USD for a stock position: prefer Treasures' precomputed usd_value, fall back
// to tokens × usd_per_token, and return "—" when neither is known (null means
// "unknown", never 0). Shared by the TTY table and the piped output so both
// agree.
function stockUsd(p: StockPosition): string {
  if (p.usd_value != null) {
    return `$${parseFloat(p.usd_value).toFixed(2)}`;
  }
  if (p.usd_per_token != null) {
    return `$${(parseFloat(p.tokens) * parseFloat(p.usd_per_token)).toFixed(2)}`;
  }
  return "—";
}

// The backend's Treasures (tokenized-stock) fetch is best-effort: when the
// upstream portfolio call fails it degrades to empty positions with a null
// asOf instead of failing the whole balance — indistinguishable here from
// "holds no stock". Detect that signature so the fetch can be retried and the
// renderer can flag it rather than silently omitting real holdings.
function stocksFetchFailed(assets: AgentAssetsResponse): boolean {
  const { positions, asOf } = assets.data.stocks;
  return positions.length === 0 && asOf === null;
}

// Fetch agent assets, retrying when the stock-portfolio side degraded. The
// upstream failure is transient (timeouts), so a couple of retries usually
// recovers real positions; if they don't, the degraded response is returned
// and the renderer warns.
async function getAssetsRetryingStocks(
  agentApi: Awaited<ReturnType<typeof getClient>>["agentApi"],
  agentId: string,
  networks: string[]
): Promise<AgentAssetsResponse> {
  let assets = await agentApi.getAgentAssets(agentId, networks);
  for (let attempt = 0; attempt < 2 && stocksFetchFailed(assets); attempt++) {
    assets = await agentApi.getAgentAssets(agentId, networks);
  }
  return assets;
}

// A nullable USD amount → "$12.34", or "—" when unknown (null ≠ 0).
function usd(v: string | null): string {
  return v == null ? "—" : `$${parseFloat(v).toFixed(2)}`;
}

// Unrealized PnL with an explicit sign so gains/losses read at a glance.
function pnl(v: string | null): string {
  if (v == null) return "—";
  const n = parseFloat(v);
  return `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;
}

// Truncate a long decimal string to keep table columns aligned.
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function printStockPositions(positions: StockPosition[]): void {
  if (positions.length === 0) return;
  console.log(`\n  ${c.bold("Tokenized Stocks")}\n`);
  const header =
    `  ${c.dim("TICKER".padEnd(8))}${c.dim("TOKENS".padEnd(14))}` +
    `${c.dim("SHARES".padEnd(13))}${c.dim("$/SHARE".padEnd(11))}` +
    `${c.dim("$/TOKEN".padEnd(11))}${c.dim("AVG ENTRY".padEnd(11))}` +
    `${c.dim("VALUE".padEnd(11))}${c.dim("PnL")}`;
  console.log(header);
  for (const p of positions) {
    console.log(
      `  ${c.cyan(p.ticker.padEnd(8))}${clip(p.tokens, 12).padEnd(14)}` +
        `${clip(p.shares ?? "—", 11).padEnd(13)}${usd(p.usd_per_share).padEnd(11)}` +
        `${usd(p.usd_per_token).padEnd(11)}${usd(p.avg_entry_price_per_share).padEnd(11)}` +
        `${stockUsd(p).padEnd(11)}${pnl(p.unrealized_pnl)}`
    );
  }
  console.log("");
}

// Coerce a raw Hyperliquid numeric field (string or number) into a string for
// display, or null when absent/empty. The backend passes HL amounts through
// untouched, so a field can be either type.
function hlNum(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

// Extract the display fields from a Hyperliquid perp position, tolerating both
// the flat hl-status shape (token/size, no notional) and the nested info-API
// shape (position.coin/szi/positionValue). When no notional is reported, derive
// an entry-price notional (|size| × entryPx) for the value column.
function hlPosition(p: HyperliquidPerpPosition): {
  coin: string;
  size: string | null;
  entry: string | null;
  value: string | null;
  upnl: string | null;
} {
  const pos = (p.position ?? p) as Record<string, unknown>;
  const coin = String(pos.coin ?? pos.token ?? "—");
  const size = hlNum(pos.szi) ?? hlNum(pos.size);
  const entry = hlNum(pos.entryPx);
  let value = hlNum(pos.positionValue);
  if (value === null && size !== null && entry !== null) {
    const v = Math.abs(parseFloat(size)) * parseFloat(entry);
    if (Number.isFinite(v)) value = v.toFixed(2);
  }
  return { coin, size, entry, value, upnl: hlNum(pos.unrealizedPnl) };
}

// A spot balance worth showing — a strictly positive total. Used as the single
// source of truth across the "has data" check, the TTY table, and the piped
// output so a wallet of all-zero spot rows never renders an empty HL block in
// the terminal while still emitting zero rows to scripts.
function hlSpotNonZero(b: HyperliquidSpotBalance): boolean {
  const t = hlNum(b.total);
  return t !== null && parseFloat(t) > 0;
}

// Only render the Hyperliquid section when there's something to show — an
// account value, a non-zero spot balance, or an open position. Mirrors how
// stock positions stay hidden when empty.
function hlHasData(
  hl?: HyperliquidBalanceSummary | null
): hl is HyperliquidBalanceSummary {
  if (!hl) return false;
  return (
    hl.balanceUsd != null ||
    (hl.spotBalances ?? []).some(hlSpotNonZero) ||
    (hl.positions?.length ?? 0) > 0
  );
}

// Render the Hyperliquid account beneath the on-chain token list: account
// value, a spot/longs split, then any non-zero spot balances and open perp
// positions. HL funds/positions live off-chain, so they never appear in the
// token list — this section is the only place `wallet balance` surfaces them.
function printHyperliquid(hl?: HyperliquidBalanceSummary | null): void {
  if (!hlHasData(hl)) return;

  console.log(`\n  ${c.bold("Hyperliquid")}\n`);
  const src =
    hl.source && hl.source !== "unknown" ? ` ${c.dim(`(${hl.source})`)}` : "";
  console.log(`  ${c.bold("Account Value:")}  ${usd(hl.balanceUsd)}${src}`);
  console.log(
    `  ${c.dim("Spot:")} ${usd(hl.spotUsd)}   ${c.dim("Longs:")} ${usd(
      hl.longPositionsUsd
    )}`
  );

  const spot = (hl.spotBalances ?? []).filter(hlSpotNonZero);
  if (spot.length) {
    console.log(`\n  ${c.dim("SPOT")}`);
    console.log(
      `  ${c.dim("COIN".padEnd(10))}${c.dim("TOTAL".padEnd(20))}${c.dim("HOLD")}`
    );
    for (const b of spot) {
      const coin = String(b.coin ?? b.token ?? "—");
      console.log(
        `  ${c.cyan(coin.padEnd(10))}${clip(hlNum(b.total) ?? "—", 18).padEnd(
          20
        )}${hlNum(b.hold) ?? "—"}`
      );
    }
  }

  const positions = hl.positions ?? [];
  if (positions.length) {
    console.log(`\n  ${c.dim("PERPS")}`);
    console.log(
      `  ${c.dim("COIN".padEnd(10))}${c.dim("SIZE".padEnd(16))}${c.dim(
        "ENTRY".padEnd(12)
      )}${c.dim("VALUE".padEnd(12))}${c.dim("PnL")}`
    );
    for (const p of positions) {
      const { coin, size, entry, value, upnl } = hlPosition(p);
      console.log(
        `  ${c.cyan(coin.padEnd(10))}${clip(size ?? "—", 14).padEnd(16)}${usd(
          entry
        ).padEnd(12)}${usd(value).padEnd(12)}${pnl(upnl)}`
      );
    }
  }
  console.log("");
}

// In --json mode the funding URL goes to stdout as JSON for machine parsing,
// but many agent harnesses buffer or suppress stdout while passing stderr
// through to the human. Mirroring a plain, copy-pasteable line to stderr
// guarantees the link reaches the human even if the agent never relays the
// JSON. Mirrors emitAuthUrlToStderr() in configure.ts.
function emitTopupUrlToStderr(url: string): void {
  process.stderr.write(
    `\n>>> Open this URL to fund your wallet:\n\n    ${url}\n\n`
  );
}

// Resolves the native currency (name + symbol + decimals) for a token's network,
// used as the fallback label for native-token balances so non-ETH chains (BNB,
// POL, MON, SOL, …) aren't mislabeled as ETH.
type NativeResolver = (
  network: string
) => { name: string; symbol: string; decimals: number } | undefined;

// Derive the displayable symbol/name/balance/usd for a token. Shared by the
// single-chain and all-chains balance views so formatting stays identical.
function formatToken(
  t: TokenInfo,
  native?: { name: string; symbol: string; decimals: number }
): {
  symbol: string;
  name: string;
  balance: string;
  usd: string;
  usdValue: number;
  contract: string;
} {
  const isNative = t.tokenAddress === null;
  const symbol =
    t.tokenMetadata.symbol ?? (isNative ? (native?.symbol ?? "ETH") : "???");
  const name =
    t.tokenMetadata.name ?? (isNative ? (native?.name ?? "Ether") : "");
  const decimals =
    t.tokenMetadata.decimals ?? (isNative ? (native?.decimals ?? 18) : 18);
  const balance = formatUnits(BigInt(t.tokenBalance), decimals);
  const unitPrice = parseFloat(t.tokenPrices?.[0]?.value ?? "0");
  const value = unitPrice * parseFloat(balance);
  return {
    symbol,
    name,
    balance,
    usd: `$${value.toFixed(2)}`,
    usdValue: Number.isFinite(value) ? value : 0,
    contract: t.tokenAddress ?? "native",
  };
}

// Render a token table for a single network's tokens (TTY mode).
function printTokenTable(tokens: TokenInfo[], nativeFor: NativeResolver): void {
  const header = `  ${c.dim("TOKEN".padEnd(10))}${c.dim(
    "NAME".padEnd(22)
  )}${c.dim("BALANCE".padEnd(24))}${c.dim("USD")}`;
  console.log(header);
  const rows = tokens
    .map((t) => formatToken(t, nativeFor(t.network)))
    .sort((a, b) => b.usdValue - a.usdValue);
  for (const { symbol, name, balance, usd } of rows) {
    const bal = balance.length > 22 ? balance.slice(0, 22) : balance;
    console.log(
      `  ${c.cyan(symbol.padEnd(10))}${name.padEnd(22)}${bal.padEnd(24)}${usd}`
    );
  }
}

// Shared balance renderer for both the unified `wallet balance` and the
// `wallet sol balance` shortcut, so EVM and Solana output stay identical
// (JSON / grouped TTY table with USD / piped TSV).
function renderBalances(opts: {
  json: boolean;
  networks: string[]; // queried order; drives grouping + the "Checked" line
  networkToChainId: Map<string, number>;
  tokens: TokenInfo[];
  // Tokenized-stock holdings span both chains and aren't tied to a queried
  // network, so they render once, after the per-network token tables.
  stocks?: StockPosition[];
  // True when the backend's stock-portfolio fetch failed (even after retries):
  // positions may exist but couldn't be read, so say so instead of rendering
  // nothing.
  stocksUnavailable?: boolean;
  // Hyperliquid funds/positions live off-chain (account-wide), so they render
  // once, after the tokens + stocks — independent of the queried network.
  hyperliquid?: HyperliquidBalanceSummary | null;
  evmAddress?: string;
  solAddress?: string;
}): void {
  const {
    json,
    networks,
    networkToChainId,
    tokens,
    stocks = [],
    stocksUnavailable = false,
    hyperliquid = null,
    evmAddress,
    solAddress,
  } = opts;
  const single = networks.length === 1;
  const nativeFor: NativeResolver = (network) => {
    const id = networkToChainId.get(network);
    return id !== undefined ? getNativeCurrency(id) : undefined;
  };

  if (json) {
    if (single) {
      const network = networks[0];
      const chainId = networkToChainId.get(network);
      const address = isSolanaChainId(chainId ?? -1) ? solAddress : evmAddress;
      outputResult(json, {
        chainId,
        network,
        address,
        tokens,
        stocks,
        ...(stocksUnavailable ? { stocksUnavailable } : {}),
        hyperliquid,
      });
    } else {
      outputResult(json, {
        chains: networks.map((network) => ({
          chainId: networkToChainId.get(network),
          network,
        })),
        address: evmAddress,
        solanaAddress: solAddress,
        tokens,
        stocks,
        ...(stocksUnavailable ? { stocksUnavailable } : {}),
        hyperliquid,
      });
    }
    return;
  }

  if (isTTY()) {
    if (single) {
      const network = networks[0];
      const chainId = networkToChainId.get(network);
      const address = isSolanaChainId(chainId ?? -1) ? solAddress : evmAddress;
      console.log(`\n${c.bold(`Wallet Balance on ${network} (${chainId})`)}\n`);
      console.log(`  ${c.bold("Address:")}  ${c.dim(address ?? "")}\n`);
      if (tokens.length === 0) {
        console.log("  No tokens found.\n");
      } else {
        printTokenTable(tokens, nativeFor);
        console.log("");
      }
    } else {
      console.log(`\n${c.bold("Wallet Balance")}\n`);
      if (evmAddress) {
        console.log(`  ${c.bold("EVM:")}     ${c.dim(evmAddress)}`);
      }
      if (solAddress) {
        console.log(`  ${c.bold("Solana:")}  ${c.dim(solAddress)}`);
      }
      console.log("");

      // Group tokens by network, preserving the queried order. Networks with
      // no tokens are hidden.
      let printedAny = false;
      for (const network of networks) {
        const group = tokens.filter((t) => t.network === network);
        if (group.length === 0) continue;
        printedAny = true;
        const chainId = networkToChainId.get(network);
        console.log(`  ${c.bold(`${network} (${chainId})`)}`);
        printTokenTable(group, nativeFor);
        console.log("");
      }
      if (!printedAny) {
        console.log("  No tokens found.\n");
      }
      console.log(
        `  ${c.dim(`Checked: ${networks.join(", ")} (${networks.length} chains)`)}\n`
      );
    }
    // Stocks span both chains — print the table once, after the token output.
    printStockPositions(stocks);
    if (stocksUnavailable) {
      console.log(
        `  ${c.yellow(
          "Tokenized-stock positions are temporarily unavailable (upstream fetch failed) — any stock you hold is not shown. Retry in a moment."
        )}\n`
      );
    }
    // Hyperliquid is account-wide — render after the on-chain + stock tables.
    printHyperliquid(hyperliquid);
  } else {
    console.log("NETWORK\tTOKEN\tNAME\tBALANCE\tUSD\tCONTRACT");
    for (const t of tokens) {
      const {
        symbol,
        name,
        balance,
        usd: usdValue,
        contract,
      } = formatToken(t, nativeFor(t.network));
      console.log(
        `${t.network}\t${symbol}\t${name}\t${balance}\t${usdValue}\t${contract}`
      );
    }
    for (const p of stocks) {
      console.log(
        `${p.token_ticker ?? p.ticker}\t${p.ticker}\t${p.tokens}\t` +
          `${p.shares ?? "—"}\t${usd(p.usd_per_share)}\t${usd(p.usd_per_token)}\t` +
          `${usd(p.avg_entry_price_per_share)}\t${stockUsd(p)}\t${pnl(p.unrealized_pnl)}\tstock`
      );
    }
    if (stocksUnavailable) {
      // Stderr so the TSV on stdout stays parseable.
      process.stderr.write(
        "warning: tokenized-stock positions unavailable (upstream fetch failed) — stock rows omitted\n"
      );
    }
    if (hlHasData(hyperliquid)) {
      console.log(
        `HL\taccountValue\t\t${usd(hyperliquid.balanceUsd)}\t${
          hyperliquid.source
        }\thl`
      );
      for (const b of (hyperliquid.spotBalances ?? []).filter(hlSpotNonZero)) {
        console.log(
          `${b.coin ?? b.token ?? "—"}\t${hlNum(b.total) ?? "—"}\t${
            hlNum(b.hold) ?? "—"
          }\thl-spot`
        );
      }
      for (const p of hyperliquid.positions ?? []) {
        const { coin, size, entry, value, upnl } = hlPosition(p);
        console.log(
          `${coin}\t${size ?? "—"}\t${usd(entry)}\t${usd(value)}\t${pnl(
            upnl
          )}\thl-perp`
        );
      }
    }
  }
}

export function registerWalletCommands(program: Command): void {
  const wallet = program.command("wallet").description("Wallet commands");

  wallet
    .command("address")
    .description("Show the configured wallet address")
    .action((_opts, cmd) => {
      const json = isJson(cmd);
      try {
        const address = getWalletAddress();
        outputResult(json, { address });
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  wallet
    .command("sign-message")
    .description("Sign a plaintext message with the active wallet")
    .requiredOption("--message <text>", "Message to sign")
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const signature = await withApprovalGate(
          (provider) =>
            provider.signMessage(Number(opts.chainId), opts.message),
          { json }
        );
        outputResult(json, { signature });
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  wallet
    .command("sign-typed-data")
    .description("Sign EIP-712 typed data with the active wallet")
    .requiredOption("--data <json>", "EIP-712 typed data as JSON string")
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        let typedData: unknown;
        try {
          typedData = JSON.parse(opts.data);
        } catch {
          throw new CliError(
            "Invalid JSON in --data",
            "VALIDATION_ERROR",
            "Provide a valid JSON string with domain, types, primaryType, and message fields."
          );
        }

        if (
          typeof typedData !== "object" ||
          typedData === null ||
          !("domain" in typedData) ||
          !("types" in typedData) ||
          !("primaryType" in typedData) ||
          !("message" in typedData)
        ) {
          throw new CliError(
            "Typed data must include domain, types, primaryType, and message fields.",
            "VALIDATION_ERROR",
            "See EIP-712 for the expected structure."
          );
        }

        const signature = await withApprovalGate(
          (provider) => provider.signTypedData(Number(opts.chainId), typedData),
          { json }
        );
        outputResult(json, { signature });
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  wallet
    .command("send-transaction")
    .description("Broadcast an EVM transaction from the active wallet")
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .requiredOption("--to <address>", "Recipient address")
    .option("--data <hex>", "Calldata as a 0x-prefixed hex string")
    .option("--value <wei>", "Value in wei (raw integer string)")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const chainId = Number(opts.chainId);
        if (!Number.isFinite(chainId)) {
          throw new CliError(
            `Invalid chain ID: ${opts.chainId}`,
            "VALIDATION_ERROR",
            "Pass a numeric chain ID, e.g. --chain-id 8453."
          );
        }

        if (!isAddress(opts.to)) {
          throw new CliError(
            `Invalid --to address: ${opts.to}`,
            "VALIDATION_ERROR",
            "Provide a 0x-prefixed 20-byte EVM address."
          );
        }

        if (opts.data !== undefined && !isHex(opts.data)) {
          throw new CliError(
            `Invalid --data: ${opts.data}`,
            "VALIDATION_ERROR",
            "Provide a 0x-prefixed hex string."
          );
        }

        let value: bigint | undefined;
        if (opts.value !== undefined) {
          try {
            value = BigInt(opts.value);
          } catch {
            throw new CliError(
              `Invalid --value: ${opts.value}`,
              "VALIDATION_ERROR",
              "Provide an integer wei amount, e.g. --value 1000000000000000000."
            );
          }
        }

        assertSponsoredChainId(chainId);

        const transactionHash = await withApprovalGate(
          (provider) =>
            provider.sendTransaction(chainId, {
              to: opts.to,
              ...(opts.data !== undefined ? { data: opts.data } : {}),
              ...(value !== undefined ? { value } : {}),
            }),
          { json }
        );
        outputResult(json, { transactionHash });
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  wallet
    .command("balance")
    .description(
      "Show token balances. With no flags, shows all sponsored EVM chains plus Solana for the current environment. Narrow with --chain-id or --cluster."
    )
    .option("--chain-id <id>", "Chain ID (EVM, or 500/501 for Solana)")
    .option("--cluster <name>", "Solana only: devnet | mainnet")
    .option(
      "--token <symbolOrAddress>",
      "Fast single-token balance: a ticker (e.g. VIRTUAL) or a contract/mint address. Requires --chain-id."
    )
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        // Fast single-token path: one targeted balance read via the backend
        // token-balance endpoint (resolves a ticker to the trade-canonical
        // token), instead of the full priced portfolio scan below.
        if (opts.token) {
          if (opts.chainId === undefined) {
            throw new CliError(
              "--token requires --chain-id",
              "VALIDATION_ERROR",
              "e.g. --chain-id 8453 (Base) or --chain-id 501 (Solana mainnet)"
            );
          }
          const chainId = Number(opts.chainId);
          if (!Number.isInteger(chainId)) {
            throw new CliError(
              "--chain-id must be an integer",
              "VALIDATION_ERROR"
            );
          }
          const activeWallet = getActiveWallet();
          const agentId = activeWallet ? getAgentId(activeWallet) : undefined;
          if (!agentId) {
            throw new CliError(
              "Agent ID not found for active wallet.",
              "NO_ACTIVE_AGENT",
              "Run `acp agent list` or `acp agent use` to set an active agent."
            );
          }
          const token = String(opts.token);
          // An 0x address (EVM) or a base58 mint (Solana) is a contract address;
          // anything else is a ticker the backend resolves. strict:false so a
          // valid-hex but non-checksummed (e.g. all-lowercase) address still
          // classifies as an address, not a ticker.
          const looksLikeAddress =
            isAddress(token, { strict: false }) ||
            /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token);
          const { agentApi } = await getClient();
          const res = await agentApi.getTokenBalance(agentId, {
            chainId,
            ...(looksLikeAddress ? { tokenAddress: token } : { symbol: token }),
          });
          outputResult(json, res.data);
          return;
        }

        // Resolve the chain-id set to query and whether this is an explicit
        // single-chain request (vs the default all-chains view).
        let chainIds: number[];
        let explicit: boolean;
        if (opts.chainId !== undefined) {
          const chainId = Number(opts.chainId);
          if (!isSolanaChainId(chainId)) assertSponsoredChainId(chainId);
          chainIds = [chainId];
          explicit = true;
        } else if (opts.cluster !== undefined) {
          chainIds = [solanaChainId(opts.cluster)];
          explicit = true;
        } else {
          chainIds = [...getEnvSponsoredChainIds(), solanaChainId()];
          explicit = false;
        }

        // Map each chain id to its network string and build a reverse lookup so
        // returned tokens can be grouped back to their chain.
        const networks: string[] = [];
        const networkToChainId = new Map<string, number>();
        for (const id of chainIds) {
          const network = CHAIN_NETWORK_MAP[id];
          if (!network) {
            if (explicit) {
              throw new CliError(
                `No network mapping for chain ID: ${id}`,
                "VALIDATION_ERROR",
                `Known networks: ${Object.entries(CHAIN_NETWORK_MAP)
                  .map(([cid, name]) => `${cid} (${name})`)
                  .join(", ")}`
              );
            }
            continue;
          }
          networks.push(network);
          networkToChainId.set(network, id);
        }

        const walletAddress = getWalletAddress();
        const activeWallet = getActiveWallet();
        const agentId = activeWallet ? getAgentId(activeWallet) : undefined;
        if (!agentId) {
          throw new CliError(
            "Agent ID not found for active wallet.",
            "NO_ACTIVE_AGENT",
            "Run `acp agent list` or `acp agent use` to set an active agent."
          );
        }

        // Resolve the Solana address only if a Solana network is in scope. In
        // the default all-chains view a missing Solana wallet is skipped
        // silently; an explicit Solana request surfaces the error.
        let solAddress: string | undefined;
        const hasSolana = networks.some((n) =>
          isSolanaChainId(networkToChainId.get(n) ?? -1)
        );
        if (hasSolana) {
          try {
            solAddress = await getSolanaWalletAddress();
          } catch (err) {
            if (explicit) throw err;
            // Drop the Solana network(s) and continue with EVM only.
            for (const [network, id] of [...networkToChainId.entries()]) {
              if (isSolanaChainId(id)) {
                networks.splice(networks.indexOf(network), 1);
                networkToChainId.delete(network);
              }
            }
          }
        }

        const { agentApi } = await getClient();
        const assets = await getAssetsRetryingStocks(
          agentApi,
          agentId,
          networks
        );
        const tokens = assets.data.tokens;
        // The Treasures portfolio spans both chains and isn't tied to the
        // queried network, so surface every position regardless of chain-id.
        const stocks = assets.data.stocks.positions;

        renderBalances({
          json,
          networks,
          networkToChainId,
          tokens,
          stocks,
          stocksUnavailable: stocksFetchFailed(assets),
          hyperliquid: assets.data.hyperliquid ?? null,
          evmAddress: walletAddress,
          solAddress,
        });
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  wallet
    .command("topup")
    .description("Add funds to your agent wallet")
    .option("--method <method>", "Payment method: coinbase or card")
    .requiredOption("--chain-id <id>", "Chain ID")
    .option("--amount <amount>", "Amount in USD")
    .option("--email <email>", "Receipt email (required for card)")
    .option("--us", "Required for US residents when paying by card")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const walletAddress = getWalletAddress();
        const chainId = Number(opts.chainId);
        assertSponsoredChainId(chainId);

        const { agentApi } = await getClient();

        // Determine payment method
        let method: string;
        if (opts.method) {
          method = opts.method;
        } else if (!isTTY() || json) {
          throw new CliError(
            "Payment method required in non-interactive mode.",
            "VALIDATION_ERROR",
            "Use --method coinbase, --method card, or --method qr"
          );
        } else {
          const methods = [
            { label: "Coinbase", value: "coinbase" },
            { label: "Card", value: "card" },
            { label: "Manual transfer (QR)", value: "qr" },
          ];
          const selected = await selectOption(
            "\n  How would you like to fund your wallet?\n",
            methods,
            (m) => m.label
          );
          method = selected.value;
        }

        if (method === "coinbase") {
          const result = await agentApi.getCoinbaseUrl(
            walletAddress,
            chainId,
            opts.amount
          );
          const { url } = result.data;
          outputResult(json, { walletAddress, method: "coinbase", url });
          if (json) {
            emitTopupUrlToStderr(url);
          } else if (isTTY()) {
            console.log(`\n  Opening Coinbase Pay in your browser...\n`);
            openBrowser(url);
          }
        } else if (method === "card") {
          let amount = opts.amount;
          let email = opts.email;

          if ((!amount || !email) && isTTY() && !json) {
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            if (!amount) amount = await prompt(rl, "  Amount (USD): ");
            if (!email) email = await prompt(rl, "  Receipt email: ");
            rl.close();
          }

          if (!amount || !email) {
            throw new CliError(
              "Amount and email required for card payment.",
              "VALIDATION_ERROR",
              "Use --amount and --email flags"
            );
          }

          // Step 1: Init Crossmint order
          const isUS = opts.us === true;
          const initResult = await agentApi.initCrossmintOrder(
            walletAddress,
            chainId,
            isUS
          );
          let signature: string | undefined;

          // Step 2: Sign challenge if needed
          if (initResult.data.needsSignature && initResult.data.challenge) {
            if (!json && isTTY()) {
              process.stdout.write("  Signing wallet verification...");
            }
            const challenge = initResult.data.challenge;
            signature = await withApprovalGate(
              (p) => p.signMessage(chainId, challenge),
              { json }
            );
            if (!json && isTTY()) {
              console.log(` ${c.green("✓")}`);
            }
          }

          // Step 3: Complete order
          const completeResult = await agentApi.completeCrossmintOrder({
            walletAddress,
            chainId,
            amount: Number(amount),
            receiptEmail: email,
            signature,
            isUS,
          });

          const { checkoutUrl } = completeResult.data;
          outputResult(json, {
            walletAddress,
            method: "card",
            checkoutUrl,
          });
          if (json) {
            emitTopupUrlToStderr(checkoutUrl);
          } else if (isTTY()) {
            console.log(`\n  Opening Crossmint checkout in your browser...\n`);
            openBrowser(checkoutUrl);
          }
        } else if (method === "qr") {
          if (!json && isTTY()) {
            console.log(`\n  ${c.bold("Wallet:")} ${walletAddress}`);
            console.log(
              `  ${c.dim(
                "Send USDC on chain " + chainId + " to the address above."
              )}\n`
            );
            qrcode.generate(walletAddress, { small: true }, (code) => {
              for (const line of code.split("\n")) {
                console.log(`  ${line}`);
              }
              console.log("");
            });
          } else {
            outputResult(json, { walletAddress, method: "qr", chainId });
          }
        } else {
          throw new CliError(
            `Unknown payment method: ${method}`,
            "VALIDATION_ERROR",
            "Use --method coinbase, --method card, or --method qr"
          );
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // -----------------------------------------------------------------------
  // Solana wallet (`wallet sol …`). The cluster is implied by IS_TESTNET
  // (devnet on testnet, mainnet otherwise); `--cluster` overrides. No chain-id.
  // -----------------------------------------------------------------------
  const sol = wallet.command("sol").description("Solana wallet commands");

  sol
    .command("address")
    .description("Show the active agent's Solana address")
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);
      try {
        const address = await getSolanaWalletAddress();
        outputResult(json, { address });
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  sol
    .command("balance")
    .description("Show SOL + SPL token balances")
    .option("--cluster <name>", "devnet | mainnet (default from env)")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const chainId = solanaChainId(opts.cluster);
        const network = CHAIN_NETWORK_MAP[chainId]!;
        const activeWallet = getActiveWallet();
        const agentId = activeWallet ? getAgentId(activeWallet) : undefined;
        if (!agentId) {
          throw new CliError(
            "Agent ID not found for active wallet.",
            "NO_ACTIVE_AGENT",
            "Run `acp agent list` or `acp agent use` to set an active agent."
          );
        }
        const address = await getSolanaWalletAddress();
        const { agentApi } = await getClient();
        const assets = await getAssetsRetryingStocks(agentApi, agentId, [
          network,
        ]);
        const tokens = assets.data.tokens;
        const stocks = assets.data.stocks.positions;

        renderBalances({
          json,
          networks: [network],
          networkToChainId: new Map([[network, chainId]]),
          tokens,
          stocks,
          stocksUnavailable: stocksFetchFailed(assets),
          hyperliquid: assets.data.hyperliquid ?? null,
          solAddress: address,
        });
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  sol
    .command("sign-message")
    .description("Sign a plaintext message with the Solana wallet")
    .requiredOption("--message <text>", "Message to sign")
    .option("--cluster <name>", "devnet | mainnet (default from env)")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const chainId = solanaChainId(opts.cluster);
        const signature = await withApprovalGate(
          (p: ISolanaProviderAdapter) => signSolanaMessage(p, opts.message),
          { chainId }
        );
        outputResult(json, { signature });
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  sol
    .command("transfer")
    .description("Send SOL, or an SPL token with --token")
    .requiredOption("--to <address>", "Recipient address")
    .requiredOption("--amount <amount>", "Amount in human units (e.g. 0.001)")
    .option("--token <mint>", "SPL mint address (omit for native SOL)")
    .option("--cluster <name>", "devnet | mainnet (default from env)")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const chainId = solanaChainId(opts.cluster);
        const signature = await withApprovalGate(
          async (provider: ISolanaProviderAdapter) => {
            const me = (await provider.getAddress()) as SolAddr;
            const to = opts.to as SolAddr;
            if (opts.token) {
              const mint = opts.token as SolAddr;
              const { decimals } = await getSplTokenBalance(
                provider.getRpc(chainId),
                me,
                mint
              );
              const amount = parseUnits(opts.amount, decimals);
              const ixs = await buildSplTransferInstructions({
                owner: me,
                recipient: to,
                mint,
                amount,
                decimals,
                payer: me,
              });
              return provider.sendInstructions(chainId, ixs);
            }
            const lamports = parseUnits(opts.amount, 9);
            return provider.sendInstructions(chainId, [
              buildSolTransferIx(me, to, lamports),
            ]);
          },
          { chainId }
        );
        outputResult(json, { signature });
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  sol
    .command("send-instructions")
    .description("Send a raw Solana instruction set (advanced)")
    .requiredOption(
      "--instructions <json>",
      "JSON array: [{ programAddress, accounts: [{ address, role }], data }]"
    )
    .option("--cluster <name>", "devnet | mainnet (default from env)")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const chainId = solanaChainId(opts.cluster);
        const parsed = JSON.parse(
          opts.instructions
        ) as SerializedSolanaInstruction[];
        const ixs = deserializeSolanaInstructions(parsed);
        const signature = await withApprovalGate(
          (p: ISolanaProviderAdapter) => p.sendInstructions(chainId, ixs),
          { chainId }
        );
        outputResult(json, { signature });
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
