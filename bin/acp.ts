#!/usr/bin/env npx tsx
import "dotenv/config";
import { program } from "commander";
import { registerClientCommands } from "../src/commands/client";
import { registerProviderCommands } from "../src/commands/provider";
import { registerJobCommands } from "../src/commands/job";
import { registerEventsCommand } from "../src/commands/events";
import { registerMessageCommands } from "../src/commands/message";
import { registerWalletCommands } from "../src/commands/wallet";
import { registerConfigureCommand } from "../src/commands/configure";
import { registerAgentCommands } from "../src/commands/agent";
import { registerBrowseCommand } from "../src/commands/browse";
import { registerOfferingCommands } from "../src/commands/offering";
import { registerResourceCommands } from "../src/commands/resource";
import { registerChainCommands } from "../src/commands/chain";
import { registerTradeCommands } from "../src/commands/trade";

program
  .name("acp")
  .version("1.0.0")
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
registerBrowseCommand(program);
registerOfferingCommands(program);
registerResourceCommands(program);
registerChainCommands(program);
registerTradeCommands(program);

program.parse();
