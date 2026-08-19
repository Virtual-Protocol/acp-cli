import type { Command } from "commander";
import {
  EVM_MAINNET_CHAINS,
  EVM_TESTNET_CHAINS,
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
} from "@virtuals-protocol/acp-node-v2";
import { isJson, outputResult, outputError, isTTY } from "../lib/output";
import { c } from "../lib/color";

export function registerChainCommands(program: Command): void {
  const chain = program.command("chain").description("Chain commands");

  chain
    .command("list")
    .description("List supported chains")
    .action((_opts, cmd) => {
      const json = isJson(cmd);
      try {
        const isTestnet = process.env.IS_TESTNET === "true";
        const chains = isTestnet ? EVM_TESTNET_CHAINS : EVM_MAINNET_CHAINS;
        const env = isTestnet ? "testnet" : "mainnet";

        // Solana has no entry in EVM_*_CHAINS, so it has to be listed
        // explicitly — jobs on it work, they just weren't discoverable here.
        const solanaChains = isTestnet
          ? [{ id: SOLANA_DEVNET_CHAIN_ID, name: "Solana Devnet" }]
          : [{ id: SOLANA_MAINNET_CHAIN_ID, name: "Solana" }];

        const items = [
          ...chains.map((ch) => ({
            id: ch.id,
            name: ch.name,
            family: "evm" as const,
          })),
          ...solanaChains.map((ch) => ({
            id: ch.id,
            name: ch.name,
            family: "solana" as const,
          })),
        ];

        if (json) {
          outputResult(json, { environment: env, chains: items });
          return;
        }

        if (isTTY()) {
          console.log(`\n${c.bold(`Supported Chains (${env})`)}\n`);
          for (const ch of items) {
            console.log(
              `  ${c.cyan(String(ch.id).padEnd(10))}${ch.name.padEnd(26)}${c.dim(ch.family)}`,
            );
          }
          console.log("");
        } else {
          // Keep the two-column contract stable for anything parsing this.
          console.log("CHAIN_ID\tNAME");
          for (const ch of items) {
            console.log(`${ch.id}\t${ch.name}`);
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
