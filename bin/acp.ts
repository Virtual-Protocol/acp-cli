#!/usr/bin/env npx tsx
import "dotenv/config";
import { program } from "commander";
import { registerBuyerCommands } from "../src/commands/buyer.js";
import { registerSellerCommands } from "../src/commands/seller.js";
import { registerJobCommands } from "../src/commands/job.js";
import { registerListenCommand } from "../src/commands/listen.js";
import { registerMessageCommands } from "../src/commands/message.js";
import { registerWalletCommands } from "../src/commands/wallet.js";

program
  .name("acp")
  .version("1.0.0")
  .description("ACP CLI — Agent Commerce Protocol tool for buyer/seller agents")
  .option("--json", "Output results as JSON");

registerBuyerCommands(program);
registerSellerCommands(program);
registerJobCommands(program);
registerListenCommand(program);
registerMessageCommands(program);
registerWalletCommands(program);

program.parse();
