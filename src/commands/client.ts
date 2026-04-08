import type { Command } from "commander";
import type { AcpAgentOffering } from "acp-node-v2";
import { AssetToken } from "acp-node-v2";
import {
  createAgentFromConfig,
  createLegacyBuyerAdapter,
} from "../lib/agentFactory";
import { isJson, outputResult, outputError, maskAddress } from "../lib/output";
import { registerJob, isLegacyJob, getLegacyJobChainId } from "../lib/config";
import { CliError } from "../lib/errors";
import { c } from "../lib/color";

export function registerClientCommands(program: Command): void {
  const client = program
    .command("client")
    .description("Client-side commands (create jobs, fund, complete, reject)");

  client
    .command("create-custom-job")
    .description("Create a custom job on-chain with a freeform description")
    .requiredOption("--provider <address>", "Provider wallet address")
    .option(
      "--evaluator <address>",
      "Evaluator wallet address (defaults to your own)"
    )
    .requiredOption("--description <text>", "Job description")
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .option("--expired-in <seconds>", "Seconds until expiry", "3600")
    .option("--hook <address>", "Hook address")
    .option(
      "--fund-transfer",
      "Use fund transfer hook (defaults to chain hook address)"
    )
    .option("--legacy", "Target a legacy (openclaw-cli) provider")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const chainId = Number(opts.chainId);

        if (opts.legacy) {
          const adapter = await createLegacyBuyerAdapter();
          const jobId = await adapter.createJob({
            providerAddress: opts.provider,
            requirement: opts.description,
            amount: 0,
            evaluatorAddress: opts.evaluator,
            expiredAt: new Date(Date.now() + Number(opts.expiredIn) * 1000),
            chainId,
          });

          registerJob(String(jobId), true, chainId);

          outputResult(json, {
            success: true,
            action: "create-job",
            protocol: "legacy",
            jobId: String(jobId),
            provider: opts.provider,
          });
          return;
        }

        // Default: v2 flow
        const agent = await createAgentFromConfig();
        const clientAddress = await agent.getAddress();
        const evaluator = opts.evaluator ?? clientAddress;
        const expiredAt =
          Math.floor(Date.now() / 1000) + Number(opts.expiredIn);
        const params = {
          providerAddress: opts.provider,
          evaluatorAddress: evaluator,
          expiredAt,
          description: opts.description,
          hookAddress: opts.hook,
        };

        const jobId = opts.fundTransfer
          ? await agent.createFundTransferJob(chainId, params)
          : await agent.createJob(chainId, params);

        registerJob(jobId.toString(), false, chainId);

        if (json) {
          outputResult(json, {
            success: true,
            action: "create-job",
            protocol: "v2",
            jobId: jobId.toString(),
            provider: opts.provider,
            evaluator,
            description: opts.description,
            hookAddress: opts.hook ?? (opts.fundTransfer ? "default" : "N/A"),
          });
        } else {
          console.log(`\n${c.green(`Job #${jobId} created successfully!`)}`);
          console.log(`  Provider:    ${c.dim(maskAddress(opts.provider))}`);
          console.log(`  Evaluator:   ${c.dim(maskAddress(evaluator))}`);
          console.log(`  Description: ${opts.description}`);
          console.log(`  Chain:       ${opts.chainId}`);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  client
    .command("fund")
    .description("Fund a job with the agreed budget (USDC)")
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--amount <usdc>", "USDC amount to fund")
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const chainId = Number(opts.chainId);

        if (isLegacyJob(opts.jobId)) {
          const legacyChainId = getLegacyJobChainId(opts.jobId) ?? chainId;
          const adapter = await createLegacyBuyerAdapter();
          await adapter.fundJob(
            Number(opts.jobId),
            `Funded ${opts.amount} USDC`
          );
          outputResult(json, {
            success: true,
            action: "fund",
            protocol: "legacy",
            jobId: opts.jobId,
            amount: opts.amount,
          });
          return;
        }

        // Default: v2 flow
        const agent = await createAgentFromConfig();
        await agent.start();
        try {
          const session = agent.getSession(chainId, opts.jobId);
          if (!session) {
            throw new CliError(
              `No session found for job ${opts.jobId}. The job may not exist or you may not be a participant.`,
              "SESSION_NOT_FOUND",
              "Run `acp job list` to see your active jobs."
            );
          }

          await session.fetchJob();
          await session.fund(AssetToken.usdc(Number(opts.amount), chainId));
          if (json) {
            outputResult(json, {
              success: true,
              action: "fund",
              protocol: "v2",
              jobId: opts.jobId,
              amount: opts.amount,
            });
          } else {
            console.log(`\n${c.green(`Job #${opts.jobId} funded with ${opts.amount} USDC`)}`);
          }
        } finally {
          await agent.stop();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  client
    .command("complete")
    .description("Approve and complete a job (as evaluator)")
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .option("--reason <text>", "Reason for completion", "Approved")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        if (isLegacyJob(opts.jobId)) {
          const legacyChainId = getLegacyJobChainId(opts.jobId) ?? Number(opts.chainId);
          const adapter = await createLegacyBuyerAdapter();
          await adapter.completeJob(Number(opts.jobId), opts.reason);
          outputResult(json, {
            success: true,
            action: "complete",
            legacy: true,
            jobId: opts.jobId,
            reason: opts.reason,
          });
          return;
        }

        const agent = await createAgentFromConfig();
        await agent.start();
        try {
          const session = agent.getSession(Number(opts.chainId), opts.jobId);
          if (!session) {
            throw new CliError(
              `No session found for job ${opts.jobId}. The job may not exist or you may not be a participant.`,
              "SESSION_NOT_FOUND",
              "Run `acp job list` to see your active jobs."
            );
          }
          await session.complete(opts.reason);
          if (json) {
            outputResult(json, {
              success: true,
              action: "complete",
              protocol: "v2",
              jobId: opts.jobId,
              reason: opts.reason,
            });
          } else {
            console.log(`\n${c.green(`Job #${opts.jobId} completed`)} — escrow released to provider`);
          }
        } finally {
          await agent.stop();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  client
    .command("reject")
    .description("Reject a job or deliverable (as evaluator)")
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .option("--reason <text>", "Reason for rejection", "Rejected")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        if (isLegacyJob(opts.jobId)) {
          const legacyChainId = getLegacyJobChainId(opts.jobId) ?? Number(opts.chainId);
          const adapter = await createLegacyBuyerAdapter();
          await adapter.rejectJob(Number(opts.jobId), opts.reason);
          outputResult(json, {
            success: true,
            action: "reject",
            legacy: true,
            jobId: opts.jobId,
            reason: opts.reason,
          });
          return;
        }

        const agent = await createAgentFromConfig();
        await agent.start();
        try {
          const session = agent.getSession(Number(opts.chainId), opts.jobId);
          if (!session) {
            throw new CliError(
              `No session found for job ${opts.jobId}. The job may not exist or you may not be a participant.`,
              "SESSION_NOT_FOUND",
              "Run `acp job list` to see your active jobs."
            );
          }
          await session.reject(opts.reason);
          if (json) {
            outputResult(json, {
              success: true,
              action: "reject",
              protocol: "v2",
              jobId: opts.jobId,
              reason: opts.reason,
            });
          } else {
            console.log(`\n${c.red(`Job #${opts.jobId} rejected`)} — escrow returned to client`);
            if (opts.reason !== "Rejected") {
              console.log(`  Reason: ${opts.reason}`);
            }
          }
        } finally {
          await agent.stop();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  client
    .command("create-job")
    .description(
      "Create a job from a provider's offering (validates requirements, auto-calculates expiry)"
    )
    .requiredOption("--provider <address>", "Provider wallet address")
    .requiredOption("--offering-name <name>", "Offering name")
    .requiredOption("--requirements <json>", "Requirements JSON matching the offering schema")
    .requiredOption("--chain-id <id>", "Chain ID", "8453")
    .option(
      "--evaluator <address>",
      "Evaluator wallet address (defaults to your own)"
    )
    .option("--legacy", "Target a legacy (openclaw-cli) provider")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        let requirements: Record<string, unknown> | string;
        try {
          requirements = JSON.parse(opts.requirements);
        } catch {
          requirements = opts.requirements;
        }

        const chainId = Number(opts.chainId);

        if (opts.legacy) {
          // Legacy flow: resolve offering from old backend
          const adapter = await createLegacyBuyerAdapter();
          const legacyAgent = await adapter.getAgent(opts.provider);
          if (!legacyAgent) {
            throw new Error(`No legacy agent found for wallet address: ${opts.provider}`);
          }
          const matches = legacyAgent.jobOfferings.filter(
            (o) => o.name === opts.offeringName
          );
          if (matches.length === 0) {
            const available = legacyAgent.jobOfferings.map((o) => o.name).join(", ");
            throw new Error(
              `Offering "${opts.offeringName}" not found. Available: ${available || "none"}`
            );
          }
          if (matches.length > 1) {
            throw new Error(
              `Multiple offerings named "${opts.offeringName}" found for this provider.`
            );
          }
          const legacyOffering = matches[0];

          const jobId = await adapter.createJob({
            providerAddress: opts.provider,
            requirement: requirements,
            amount:
              legacyOffering.priceType === "fixed" ? Number(legacyOffering.price) : 0,
            evaluatorAddress: opts.evaluator,
            expiredAt: new Date(
              Date.now() + (legacyOffering.slaMinutes || 60) * 60 * 1000
            ),
            offeringName: legacyOffering.name,
            chainId,
          });

          registerJob(String(jobId), true, chainId);

          outputResult(json, {
            success: true,
            action: "create-job-from-offering",
            protocol: "legacy",
            jobId: String(jobId),
            provider: opts.provider,
            offering: legacyOffering.name,
          });
          return;
        }

        // Default: v2 flow — resolve offering from v2 backend
        const agent = await createAgentFromConfig();
        const providerAgent = await agent.getAgentByWalletAddress(opts.provider);
        if (!providerAgent) {
          throw new Error(`No agent found for wallet address: ${opts.provider}`);
        }
        const matches = providerAgent.offerings.filter(
          (o: AcpAgentOffering) => o.name === opts.offeringName
        );
        if (matches.length === 0) {
          const available = providerAgent.offerings.map((o: AcpAgentOffering) => o.name).join(", ");
          throw new Error(
            `Offering "${opts.offeringName}" not found. Available: ${available || "none"}`
          );
        }
        if (matches.length > 1) {
          throw new Error(
            `Multiple offerings named "${opts.offeringName}" found for this provider.`
          );
        }
        const offering = matches[0];

        const evaluator = opts.evaluator ?? (await agent.getAddress());
        const jobId = await agent.createJobFromOffering(
          chainId,
          offering,
          opts.provider,
          requirements,
          { evaluatorAddress: evaluator }
        );

        registerJob(jobId.toString(), false, chainId);

        if (json) {
          outputResult(json, {
            success: true,
            action: "create-job-from-offering",
            protocol: "v2",
            jobId: jobId.toString(),
            provider: opts.provider,
            offering: offering.name,
          });
        } else {
          console.log(`\n${c.green(`Job #${jobId} created from offering "${offering.name}"`)}`);
          console.log(`  Provider: ${c.dim(maskAddress(opts.provider))}`);
          console.log(`  Chain:    ${opts.chainId}`);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
