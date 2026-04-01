#!/usr/bin/env npx tsx
import "dotenv/config";
import { program } from "commander";
import { registerBuyerCommands } from "../src/commands/buyer";
import { registerSellerCommands } from "../src/commands/seller";
import { registerJobCommands } from "../src/commands/job";
import { registerEventsCommand } from "../src/commands/events";
import { registerMessageCommands } from "../src/commands/message";
import { registerWalletCommands } from "../src/commands/wallet";
import { registerConfigureCommand } from "../src/commands/configure";
import { registerAgentCommands } from "../src/commands/agent";
import { registerBrowseCommand } from "../src/commands/browse";
import { registerOfferingCommands } from "../src/commands/offering";

program
  .name("acp")
  .version("1.0.0")
  .description("ACP CLI — Agent Commerce Protocol tool for buyer/seller agents")
  .option("--json", "Output results as JSON");

registerBuyerCommands(program);
registerSellerCommands(program);
registerJobCommands(program);
registerEventsCommand(program);
registerMessageCommands(program);
registerWalletCommands(program);
registerConfigureCommand(program);
registerAgentCommands(program);
registerBrowseCommand(program);
registerOfferingCommands(program);

program.parse();
