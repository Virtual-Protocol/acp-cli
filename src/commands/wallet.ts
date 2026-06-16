import type { Command } from "commander";
import * as readline from "readline";
import { formatUnits, parseUnits, isAddress, isHex } from "viem";
import {
  buildSolTransferIx,
  buildSplTransferInstructions,
  getSplTokenBalance,
  AccountRole,
  type SolanaInstructionLike,
} from "@virtuals-protocol/acp-node-v2";
import { isJson, outputResult, outputError, isTTY } from "../lib/output";
import { getWalletAddress, getSolanaWalletAddress } from "../lib/agentFactory";
import { getClient } from "../lib/api/client";
import { getAgentId, getActiveWallet } from "../lib/config";
import { CHAIN_NETWORK_MAP } from "../lib/api/agent";
import type { TokenInfo } from "../lib/api/agent";
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
import { withApprovalGate, withSolanaWallet } from "../lib/walletGate";
import qrcode from "qrcode-terminal";

// Address type accepted by the SDK Solana helpers (branded), derived without a
// direct @solana/kit import.
type SolAddr = Parameters<typeof buildSolTransferIx>[0];

const ACCOUNT_ROLE_BY_NAME: Record<string, AccountRole> = {
  writable_signer: AccountRole.WRITABLE_SIGNER,
  writable: AccountRole.WRITABLE,
  readonly_signer: AccountRole.READONLY_SIGNER,
  readonly: AccountRole.READONLY,
};

// Instruction data accepts hex (0x…) or base64.
function decodeIxData(data: string): Uint8Array {
  const buf = data.startsWith("0x")
    ? Buffer.from(data.slice(2), "hex")
    : Buffer.from(data, "base64");
  return Uint8Array.from(buf);
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
  contract: string;
} {
  const isNative = t.tokenAddress === null;
  const symbol =
    t.tokenMetadata.symbol ?? (isNative ? native?.symbol ?? "ETH" : "???");
  const name =
    t.tokenMetadata.name ?? (isNative ? native?.name ?? "Ether" : "");
  const decimals =
    t.tokenMetadata.decimals ?? (isNative ? native?.decimals ?? 18 : 18);
  const balance = formatUnits(BigInt(t.tokenBalance), decimals);
  const unitPrice = parseFloat(t.tokenPrices?.[0]?.value ?? "0");
  const value = unitPrice * parseFloat(balance);
  return {
    symbol,
    name,
    balance,
    usd: `$${value.toFixed(2)}`,
    contract: t.tokenAddress ?? "native",
  };
}

// Render a token table for a single network's tokens (TTY mode).
function printTokenTable(tokens: TokenInfo[], nativeFor: NativeResolver): void {
  const header = `  ${c.dim("TOKEN".padEnd(10))}${c.dim(
    "NAME".padEnd(22)
  )}${c.dim("BALANCE".padEnd(24))}${c.dim("USD")}`;
  console.log(header);
  for (const t of tokens) {
    const { symbol, name, balance, usd } = formatToken(t, nativeFor(t.network));
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
  evmAddress?: string;
  solAddress?: string;
}): void {
  const { json, networks, networkToChainId, tokens, evmAddress, solAddress } =
    opts;
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
      outputResult(json, { chainId, network, address, tokens });
    } else {
      outputResult(json, {
        chains: networks.map((network) => ({
          chainId: networkToChainId.get(network),
          network,
        })),
        address: evmAddress,
        solanaAddress: solAddress,
        tokens,
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
  } else {
    console.log("NETWORK\tTOKEN\tNAME\tBALANCE\tUSD\tCONTRACT");
    for (const t of tokens) {
      const { symbol, name, balance, usd, contract } = formatToken(
        t,
        nativeFor(t.network)
      );
      console.log(
        `${t.network}\t${symbol}\t${name}\t${balance}\t${usd}\t${contract}`
      );
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
          (provider) => provider.signMessage(Number(opts.chainId), opts.message),
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
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
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
        const assets = await agentApi.getAgentAssets(agentId, networks);
        const tokens = assets.data.tokens;

        renderBalances({
          json,
          networks,
          networkToChainId,
          tokens,
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
        const assets = await agentApi.getAgentAssets(agentId, [network]);
        const tokens = assets.data.tokens;

        renderBalances({
          json,
          networks: [network],
          networkToChainId: new Map([[network, chainId]]),
          tokens,
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
        const signature = await withSolanaWallet(chainId, (p) =>
          p.signMessage(opts.message)
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
        const signature = await withSolanaWallet(chainId, async (provider) => {
          const me = (await provider.getAddress()) as SolAddr;
          const to = opts.to as SolAddr;
          if (opts.token) {
            const mint = opts.token as SolAddr;
            const { decimals } = await getSplTokenBalance(
              provider.getRpc(),
              me,
              mint
            );
            const amount = parseUnits(opts.amount, decimals);
            const ixs = await buildSplTransferInstructions({
              owner: me,
              recipient: to,
              mint,
              amount,
              payer: me,
            });
            return provider.sendInstructions(ixs);
          }
          const lamports = parseUnits(opts.amount, 9);
          return provider.sendInstructions([buildSolTransferIx(me, to, lamports)]);
        });
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
      'JSON array: [{ programAddress, accounts: [{ address, role }], data }]'
    )
    .option("--cluster <name>", "devnet | mainnet (default from env)")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const chainId = solanaChainId(opts.cluster);
        const parsed = JSON.parse(opts.instructions) as Array<{
          programAddress: string;
          accounts: { address: string; role: string }[];
          data: string;
        }>;
        const ixs: SolanaInstructionLike[] = parsed.map((ix) => ({
          programAddress: ix.programAddress as SolAddr,
          accounts: ix.accounts.map((a) => {
            const role = ACCOUNT_ROLE_BY_NAME[a.role.toLowerCase()];
            if (role === undefined) {
              throw new CliError(
                `Unknown account role "${a.role}".`,
                "VALIDATION_ERROR",
                "Use writable_signer | writable | readonly_signer | readonly."
              );
            }
            return { address: a.address as SolAddr, role };
          }),
          data: decodeIxData(ix.data),
        }));
        const signature = await withSolanaWallet(chainId, (p) =>
          p.sendInstructions(ixs)
        );
        outputResult(json, { signature });
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
