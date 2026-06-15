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
import { CliError } from "../lib/errors";
import { assertSponsoredChainId, solanaChainId } from "../lib/chains";
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
    .description("Show token balances for the active wallet")
    .requiredOption("--chain-id <id>", "Chain ID")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const chainId = Number(opts.chainId);
        assertSponsoredChainId(chainId);

        const network = CHAIN_NETWORK_MAP[chainId];
        if (!network) {
          throw new CliError(
            `No network mapping for chain ID: ${chainId}`,
            "VALIDATION_ERROR",
            `Known networks: ${Object.entries(CHAIN_NETWORK_MAP)
              .map(([id, name]) => `${id} (${name})`)
              .join(", ")}`
          );
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

        const { agentApi } = await getClient();
        const assets = await agentApi.getAgentAssets(agentId, [network]);
        const tokens = assets.data.tokens;

        if (json) {
          outputResult(json, {
            chainId,
            network,
            address: walletAddress,
            tokens,
          });
          return;
        }

        if (isTTY()) {
          console.log(
            `\n${c.bold(`Wallet Balance on ${network} (${chainId})`)}\n`
          );
          console.log(`  ${c.bold("Address:")}  ${c.dim(walletAddress)}\n`);

          if (tokens.length === 0) {
            console.log("  No tokens found.\n");
          } else {
            const header = `  ${c.dim("TOKEN".padEnd(10))}${c.dim(
              "NAME".padEnd(22)
            )}${c.dim("BALANCE".padEnd(24))}${c.dim("USD")}`;
            console.log(header);
            for (const t of tokens) {
              const isNative = t.tokenAddress === null;
              const symbol =
                t.tokenMetadata.symbol ?? (isNative ? "ETH" : "???");
              const name = t.tokenMetadata.name ?? (isNative ? "Ether" : "");
              const decimals = t.tokenMetadata.decimals ?? 18;
              const balance = formatUnits(BigInt(t.tokenBalance), decimals);
              const bal = balance.length > 22 ? balance.slice(0, 22) : balance;
              const unitPrice = parseFloat(t.tokenPrices?.[0]?.value ?? "0");
              const value = unitPrice * parseFloat(balance);
              const price = `$${value.toFixed(2)}`;
              console.log(
                `  ${c.cyan(symbol.padEnd(10))}${name.padEnd(22)}${bal.padEnd(
                  24
                )}${price}`
              );
            }
            console.log("");
          }
        } else {
          console.log("TOKEN\tNAME\tBALANCE\tUSD\tCONTRACT");
          for (const t of tokens) {
            const isNative = t.tokenAddress === null;
            const symbol = t.tokenMetadata.symbol ?? (isNative ? "ETH" : "???");
            const name = t.tokenMetadata.name ?? (isNative ? "Ether" : "");
            const decimals = t.tokenMetadata.decimals ?? 18;
            const balance = formatUnits(BigInt(t.tokenBalance), decimals);
            const unitPrice = parseFloat(t.tokenPrices?.[0]?.value ?? "0");
            const value = unitPrice * parseFloat(balance);
            console.log(
              `${symbol}\t${name}\t${balance}\t$${value.toFixed(2)}\t${
                t.tokenAddress ?? "native"
              }`
            );
          }
        }
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

        if (json) {
          outputResult(json, { chainId, network, address, tokens });
          return;
        }

        console.log(`\n${c.bold(`Solana balance on ${network}`)}\n`);
        console.log(`  ${c.bold("Address:")}  ${c.dim(address)}\n`);
        if (tokens.length === 0) {
          console.log("  No tokens found.\n");
        } else {
          for (const t of tokens) {
            const isNative = t.tokenAddress === null;
            const symbol = t.tokenMetadata.symbol ?? (isNative ? "SOL" : "???");
            const decimals = t.tokenMetadata.decimals ?? (isNative ? 9 : 0);
            const balance = formatUnits(BigInt(t.tokenBalance), decimals);
            console.log(`  ${c.cyan(symbol.padEnd(10))}${balance}`);
          }
          console.log("");
        }
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
