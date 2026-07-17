import type { Command } from "commander";
import { encodeFunctionData, erc20Abi, isAddress, parseUnits } from "viem";
import { USDC_ADDRESSES, USDC_DECIMALS } from "@virtuals-protocol/acp-node-v2";
import { isJson, outputResult, outputError, isTTY } from "../lib/output";
import { c } from "../lib/color";
import { getClient } from "../lib/api/client";
import { printTable } from "../lib/prompt";
import { getActiveAgentId } from "../lib/activeAgent";
import { createProviderAdapter, getWalletAddress } from "../lib/agentFactory";
import { formatChainId, formatChainIds } from "../lib/chains";
import { CliError } from "../lib/errors";

// ── Registration ────────────────────────────────────────────────────

export function registerComputeCommands(program: Command): void {
  const compute = program
    .command("compute")
    .description("Manage agent compute (LLM-inference) accounts");

  compute
    .command("status")
    .description("Show the agent's compute account balance and settings")
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const account = await agentApi.getComputeAccount(agentId);

        if (json) {
          outputResult(json, account as unknown as Record<string, unknown>);
          return;
        }

        const rows: [string, string][] = [
          ["Limit", `$${Number(account.limit).toFixed(2)}`],
          ["Remaining", `$${Number(account.limitRemaining).toFixed(2)}`],
          ["Usage", `$${Number(account.usage).toFixed(2)}`],
        ];
        printTable(rows);
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  compute
    .command("top-up")
    .description(
      "Top up the compute account by transferring USDC to the ACP fee wallet"
    )
    .requiredOption("--amount <amount>", "Amount of USDC to top up (min 1)")
    .option(
      "--chain-id <id>",
      "Chain to send USDC on (defaults to the account's preferred billing chain)",
      "8453"
    )
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const amount = Number(opts.amount);
        if (!Number.isFinite(amount) || amount < 1 || amount > 1000) {
          throw new CliError(
            `Invalid --amount: ${opts.amount}`,
            "VALIDATION_ERROR",
            "Top up amount must be between 1 to 1000"
          );
        }

        const { agentApi } = await getClient();
        const agentId = getActiveAgentId(json);
        if (!agentId) return;

        const chainId = Number(opts.chainId);
        const usdcAddress = USDC_ADDRESSES[chainId];
        const usdcDecimals = USDC_DECIMALS[chainId];
        if (!usdcAddress || usdcDecimals === undefined) {
          throw new CliError(
            `USDC is not configured for chain ${chainId}.`,
            "VALIDATION_ERROR",
            `Supported chains: ${formatChainIds(
              Object.keys(USDC_ADDRESSES).map(Number)
            )}`
          );
        }

        const provider = await createProviderAdapter();
        const supportedChainIds = await provider.getSupportedChainIds();
        if (!supportedChainIds.includes(chainId)) {
          throw new CliError(
            `Unsupported chain ID: ${formatChainId(chainId)}`,
            "VALIDATION_ERROR",
            `Supported chains: ${formatChainIds(supportedChainIds)}`
          );
        }

        const { walletAddress: feeWallet, feeBps } =
          await agentApi.getComputeFeeData();

        const feeAmount = (amount * feeBps) / 10_000;
        const totalAmount = amount + feeAmount;

        const value = parseUnits(
          totalAmount.toFixed(usdcDecimals),
          usdcDecimals
        );

        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [feeWallet as `0x${string}`, value],
        });

        if (!json && isTTY()) {
          console.log(
            `  Transferring ${c.bold(`${totalAmount} USDC`)} to wallet ${c.dim(
              feeWallet
            )} on chain ${chainId}...`
          );
        }

        const txnHash = await provider.sendTransaction(chainId, {
          to: usdcAddress as `0x${string}`,
          data,
        });

        const agentAddress = getWalletAddress();
        try {
          await agentApi.computeTopUp(agentId, agentAddress, amount, txnHash);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new CliError(
            `Backend confirmation failed after compute top-up transaction was broadcast. Tx hash: ${txnHash}. ${message}`,
            "API_ERROR",
            "The on-chain transaction was already sent. Keep the Tx Hash and retry or contact support with it.",
            {
              action: "compute top-up",
              txnHash,
            }
          );
        }

        if (json) {
          outputResult(json, {
            amount,
            totalAmount,
            chainId,
            feeWallet,
            txnHash,
          });
          return;
        }

        console.log(
          `\n${c.green(
            "Successfully top up your compute account, your balance will be increased shortly."
          )}`
        );
        printTable([
          ["Top Up Amount", `${amount} USDC`],
          ["Total Paid", `${totalAmount} USDC`],
          ["Chain", String(chainId)],
          ["Fee Wallet", feeWallet],
          ["Tx Hash", txnHash],
        ]);
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
