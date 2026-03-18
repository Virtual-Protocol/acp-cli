import type { Command } from "commander";
import { io } from "socket.io-client";
import { isJson, outputResult, outputError } from "../lib/output.js";
import { getWalletAddress, getSocketUrl } from "../lib/agentFactory.js";

export function registerMessageCommands(program: Command): void {
  const message = program
    .command("message")
    .description("Messaging commands");

  message
    .command("send")
    .description("Send a chat message in a job room (lightweight, no wallet setup)")
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--chain-id <id>", "Chain ID", "84532")
    .requiredOption("--content <text>", "Message content")
    .option("--content-type <type>", "Content type (text, proposal, deliverable, structured)", "text")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const wallet = getWalletAddress();
        const serverUrl = getSocketUrl();

        const socket = io(serverUrl, { auth: { walletAddress: wallet } });

        await new Promise<void>((resolve, reject) => {
          socket.on("connect", resolve);
          socket.on("connect_error", reject);
          setTimeout(() => reject(new Error("Socket connection timeout")), 10000);
        });

        socket.emit("job:message", {
          chainId: Number(opts.chainId),
          onChainJobId: opts.jobId,
          content: opts.content,
          contentType: opts.contentType,
        });

        // Brief delay to ensure message is delivered before disconnect
        await new Promise((r) => setTimeout(r, 500));
        socket.disconnect();

        outputResult(json, {
          success: true,
          action: "send-message",
          jobId: opts.jobId,
          content: opts.content,
        });
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });
}
