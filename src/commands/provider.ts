import type { Command } from "commander";
import { AssetToken } from "@virtuals-protocol/acp-node-v2";
import { createAgentFromConfig } from "../lib/agentFactory";
import { isJson, outputResult, outputError, maskAddress } from "../lib/output";
import { CliError } from "../lib/errors";
import { c } from "../lib/color";
import { resolveSubscriptionAddon } from "../lib/subscription";

export function registerProviderCommands(program: Command): void {
  const provider = program
    .command("provider")
    .description("Provider-side commands (set budget, submit deliverable)");

  provider
    .command("set-budget")
    .description("Propose a budget for a job (USDC)")
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--amount <usdc>", "USDC amount to propose")
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .option("--package-id <id>", "Package ID")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const agent = await createAgentFromConfig();
        await agent.start();
        try {
          const chainId = Number(opts.chainId);
          const session = agent.getSession(chainId, opts.jobId);
          if (!session) {
            throw new CliError(
              `No session found for job ${opts.jobId}. The job may not exist or you may not be a participant.`,
              "SESSION_NOT_FOUND",
              "Run `acp job list` to see your active jobs."
            );
          }

          const { subscription, totalBudget } = await resolveSubscriptionAddon(
            agent,
            session,
            opts.amount,
            chainId,
            opts.packageId
          );

          if (subscription) {
            await session.setBudgetWithSubscription(
              AssetToken.usdc(totalBudget, chainId),
              BigInt(subscription.duration),
              BigInt(subscription.packageId)
            );
          } else {
            await session.setBudget(AssetToken.usdc(totalBudget, chainId));
          }

          if (json) {
            outputResult(json, {
              success: true,
              action: "set-budget",
              jobId: opts.jobId,
              amount: totalBudget,
            });
          } else {
            console.log(
              `\n${c.green(
                `Budget of ${totalBudget} USDC proposed for Job #${opts.jobId}`
              )}`
            );
          }
        } finally {
          await agent.stop();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  provider
    .command("set-budget-with-fund-request")
    .description(
      "Propose a budget and request a fund transfer. The budget (--amount) is " +
        "your service fee (USDC). The fund transfer (--transfer-amount) is " +
        "capital the client provides for job execution (e.g., tokens for trades, " +
        "gas for on-chain ops). These are separate: the budget pays you, the " +
        "fund transfer gives you working capital."
    )
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--amount <usdc>", "USDC service fee")
    .requiredOption(
      "--transfer-amount <amount>",
      "Amount of token to request from client"
    )
    .requiredOption(
      "--destination <address>",
      "Recipient address for the working capital"
    )
    .option(
      "--transfer-token <address>",
      "ERC-20 token contract address for the fund transfer (defaults to USDC)"
    )
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .option("--package-id <id>", "Package ID")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const agent = await createAgentFromConfig();
        await agent.start();
        try {
          const chainId = Number(opts.chainId);
          const session = agent.getSession(chainId, opts.jobId);
          if (!session) {
            throw new CliError(
              `No session found for job ${opts.jobId}. The job may not exist or you may not be a participant.`,
              "SESSION_NOT_FOUND",
              "Run `acp job list` to see your active jobs."
            );
          }
          const transferToken = opts.transferToken
            ? await agent.resolveAssetToken(
                opts.transferToken as `0x${string}`,
                Number(opts.transferAmount),
                chainId
              )
            : AssetToken.usdc(Number(opts.transferAmount), chainId);

          const { subscription, totalBudget } = await resolveSubscriptionAddon(
            agent,
            session,
            opts.amount,
            chainId,
            opts.packageId
          );

          if (subscription) {
            await session.setBudgetWithSubscriptionAndFundRequest(
              AssetToken.usdc(totalBudget, chainId),
              BigInt(subscription.duration),
              BigInt(subscription.packageId),
              transferToken,
              opts.destination
            );
          } else {
            await session.setBudgetWithFundRequest(
              AssetToken.usdc(totalBudget, chainId),
              transferToken,
              opts.destination
            );
          }

          if (json) {
            outputResult(json, {
              success: true,
              action: "set-budget-with-fund-request",
              jobId: opts.jobId,
              amount: totalBudget,
              transferAmount: opts.transferAmount,
              transferTokenSymbol: transferToken.symbol,
              transferTokenAddress: transferToken.address,
              destination: opts.destination,
            });
          } else {
            console.log(
              `\n${c.green(
                `Budget of ${totalBudget} USDC proposed for Job #${opts.jobId}`
              )}`
            );
            console.log(
              `  Fund transfer: ${opts.transferAmount} ${
                transferToken.symbol
              } → ${maskAddress(opts.destination)}`
            );
          }
        } finally {
          await agent.stop();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  provider
    .command("submit")
    .description("Submit a deliverable for a job")
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--deliverable <text>", "Deliverable content or reference")
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .option(
      "--transfer-amount <amount>",
      "Amount of token to transfer on submit"
    )
    .option(
      "--transfer-token <address>",
      "ERC-20 token contract address for the transfer (defaults to USDC)"
    )
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const agent = await createAgentFromConfig();
        await agent.start();
        try {
          const chainId = Number(opts.chainId);
          const session = agent.getSession(chainId, opts.jobId);
          if (!session) {
            throw new CliError(
              `No session found for job ${opts.jobId}. The job may not exist or you may not be a participant.`,
              "SESSION_NOT_FOUND",
              "Run `acp job list` to see your active jobs."
            );
          }
          if (opts.transferToken && !opts.transferAmount) {
            throw new CliError(
              "--transfer-token requires --transfer-amount",
              "VALIDATION_ERROR",
              "Provide --transfer-amount along with --transfer-token."
            );
          }
          const transferToken = opts.transferAmount
            ? opts.transferToken
              ? await agent.resolveAssetToken(
                  opts.transferToken as `0x${string}`,
                  Number(opts.transferAmount),
                  chainId
                )
              : AssetToken.usdc(Number(opts.transferAmount), chainId)
            : undefined;
          await session.submit(opts.deliverable, transferToken);
          if (json) {
            outputResult(json, {
              success: true,
              action: "submit",
              jobId: opts.jobId,
              deliverable: opts.deliverable,
              ...(transferToken && {
                transferAmount: opts.transferAmount,
                transferTokenSymbol: transferToken.symbol,
                transferTokenAddress: transferToken.address,
              }),
            });
          } else {
            console.log(
              `\n${c.green(`Deliverable submitted for Job #${opts.jobId}`)}`
            );
          }
        } finally {
          await agent.stop();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
