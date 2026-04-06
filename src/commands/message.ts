import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output";
import { createAgentFromConfig } from "../lib/agentFactory";

export function registerMessageCommands(program: Command): void {
  const message = program
    .command("message")
    .description("Messaging commands");

  message
    .command("send")
    .description("Send a chat message in a job room")
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--chain-id <id>", "Chain ID", "84532")
    .requiredOption("--content <text>", "Message content")
    .option(
      "--content-type <type>",
      "Content type (text, proposal, deliverable, structured)",
      "text"
    )
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const agent = await createAgentFromConfig();
        await agent.sendMessage(
          Number(opts.chainId),
          opts.jobId,
          opts.content,
          opts.contentType
        );
        if (json) {
          outputResult(json, {
            success: true,
            action: "send-message",
            jobId: opts.jobId,
            content: opts.content,
          });
        } else {
          console.log(`\nMessage sent in Job #${opts.jobId}`);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
