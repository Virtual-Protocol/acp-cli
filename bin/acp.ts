#!/usr/bin/env node
import "dotenv/config";
import { program } from "commander";
import { createRequire } from "node:module";
import { registerClientCommands } from "../src/commands/client";
import { registerProviderCommands } from "../src/commands/provider";
import { registerJobCommands } from "../src/commands/job";
import { registerEventsCommand } from "../src/commands/events";
import { registerMessageCommands } from "../src/commands/message";
import { registerWalletCommands } from "../src/commands/wallet";
import { registerConfigureCommand } from "../src/commands/configure";
import { registerAgentCommands } from "../src/commands/agent";
import { registerPolicyCommands } from "../src/commands/policy";
import { registerBrowseCommand } from "../src/commands/browse";
import { registerOfferingCommands } from "../src/commands/offering";
import { registerResourceCommands } from "../src/commands/resource";
import { registerSubscriptionCommands } from "../src/commands/subscription";
import { registerChainCommands } from "../src/commands/chain";
import { registerEmailCommands } from "../src/commands/email";
import { registerCardCommands } from "../src/commands/card";
import { registerComputeCommands } from "../src/commands/compute";
import { registerSkillCommands } from "../src/commands/skill";
import { registerTradeCommands } from "../src/commands/trade";
import { registerSwapCommands } from "../src/commands/swap";

const require = createRequire(import.meta.url);

function getPackageVersion(): string {
  for (const packagePath of ["../package.json", "../../package.json"]) {
    try {
      const pkg = require(packagePath) as { version?: unknown };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // Source runs from bin/, bundled dist runs from dist/bin/.
    }
  }
  return "1.0.0";
}

program
  .name("acp")
  .version(getPackageVersion())
  .description("ACP CLI — Agent Commerce Protocol tool for client/provider agents")
  .option("--json", "Output results as JSON")
  .addHelpText(
    "after",
    "\nGet started:\n  acp configure → acp agent create → acp agent add-signer → acp browse\n" +
      "\nTrading:\n" +
      "  acp trade  Swaps (cross-chain/spot), Hyperliquid deposits, and HL perps/spot.\n" +
      "             Routes by the params you pass — see `acp trade --help`.\n"
  );

registerClientCommands(program);
registerProviderCommands(program);
registerJobCommands(program);
registerEventsCommand(program);
registerMessageCommands(program);
registerWalletCommands(program);
registerConfigureCommand(program);
registerAgentCommands(program);
registerPolicyCommands(program);
registerBrowseCommand(program);
registerOfferingCommands(program);
registerResourceCommands(program);
registerSubscriptionCommands(program);
registerChainCommands(program);
registerEmailCommands(program);
registerCardCommands(program);
registerComputeCommands(program);
registerSkillCommands(program);
registerTradeCommands(program);
registerSwapCommands(program);

program.parse();
