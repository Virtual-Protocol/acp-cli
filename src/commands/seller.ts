import type { Command } from "commander";
import { Erc20Token } from "acp-node-v2";
import { createAgentFromEnv } from "../lib/agentFactory.js";
import { isJson, outputResult, outputError } from "../lib/output.js";

export function registerSellerCommands(program: Command): void {
  const seller = program
    .command("seller")
    .description("Seller-side commands (set budget, submit deliverable)");

  seller
    .command("set-budget")
    .description("Propose a budget for a job (USDC)")
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--amount <usdc>", "USDC amount to propose")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const agent = await createAgentFromEnv();
        await agent.start();
        try {
          const session = agent.getSession(opts.jobId);
          if (!session) {
            throw new Error(`No session found for job ${opts.jobId}. The job may not exist or you may not be a participant.`);
          }
          await session.setBudget(Erc20Token.usdc(Number(opts.amount)));
          outputResult(json, {
            success: true,
            action: "set-budget",
            jobId: opts.jobId,
            amount: opts.amount,
          });
        } finally {
          await agent.stop();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  seller
    .command("submit")
    .description("Submit a deliverable for a job")
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--deliverable <text>", "Deliverable content or reference")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const agent = await createAgentFromEnv();
        await agent.start();
        try {
          const session = agent.getSession(opts.jobId);
          if (!session) {
            throw new Error(`No session found for job ${opts.jobId}.`);
          }
          await session.submit(opts.deliverable);
          outputResult(json, {
            success: true,
            action: "submit",
            jobId: opts.jobId,
            deliverable: opts.deliverable,
          });
        } finally {
          await agent.stop();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });
}
