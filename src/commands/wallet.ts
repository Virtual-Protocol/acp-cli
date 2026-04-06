import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output";
import { getWalletAddress } from "../lib/agentFactory";

export function registerWalletCommands(program: Command): void {
  const wallet = program
    .command("wallet")
    .description("Wallet commands");

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
}
