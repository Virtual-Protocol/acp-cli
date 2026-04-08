import type { Command } from "commander";
import type { AcpAgentDetail } from "acp-node-v2";
import { isJson, outputError, isTTY } from "../lib/output";
import {
  createAgentFromConfig,
  createLegacyBuyerAdapter,
} from "../lib/agentFactory";
import { c } from "../lib/color";

type Offering = AcpAgentDetail["offerings"][number];
type Resource = AcpAgentDetail["resources"][number];

function formatPrice(priceType: string, priceValue: number | string): string {
  const value =
    typeof priceValue === "string" ? parseFloat(priceValue) : priceValue;
  if (priceType.toUpperCase() === "FIXED") {
    return `${value} USDC`;
  }
  if (priceType.toUpperCase() === "PERCENTAGE") {
    return `${parseFloat((value * 100).toFixed(2))}%`;
  }
  return `${value} (${priceType})`;
}

function formatOneLiner(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function printOffering(o: Offering): void {
  console.log(`    - ${o.name}`);
  console.log(`      Description:   ${o.description}`);
  console.log(`      Requirements:  ${formatOneLiner(o.requirements)}`);
  console.log(`      Deliverable:   ${formatOneLiner(o.deliverable)}`);
  console.log(`      Price:         ${formatPrice(o.priceType, o.priceValue)}`);
  console.log(`      SLA:           ${o.slaMinutes} min`);
  console.log(`      Required Funds: ${o.requiredFunds ? "Yes" : "No"}`);
}

function printResource(r: Resource): void {
  console.log(`    - ${r.name}`);
  console.log(`      Description:   ${r.description}`);
  console.log(`      Params:        ${formatOneLiner(r.params)}`);
  console.log(`      URL:           ${r.url}`);
}

function printLegacyAgent(a: {
  name: string;
  walletAddress: string;
  jobOfferings: readonly any[];
}, chainId: number): void {
  console.log(`  Name:           ${a.name} [legacy]`);
  console.log(`  Wallet:         ${a.walletAddress}`);
  console.log(`  Chain:          ${chainId}`);
  if (a.jobOfferings.length > 0) {
    console.log(`  Offerings:`);
    for (const o of a.jobOfferings) {
      console.log(`    - ${o.name}`);
      if (o.price != null) console.log(`      Price:         ${formatPrice(o.priceType ?? "FIXED", o.price)}`);
      if (o.slaMinutes != null) console.log(`      SLA:           ${o.slaMinutes} min`);
      if (o.requiredFunds != null) console.log(`      Required Funds: ${o.requiredFunds ? "Yes" : "No"}`);
    }
  } else {
    console.log(`  Offerings:      No offerings`);
  }
  console.log("");
}

export function registerBrowseCommand(program: Command): void {
  program
    .command("browse [query]")
    .description("Browse available agents")
    .option("--chain-ids <ids>", "Comma-separated chain IDs to filter by")
    .option(
      "--sort-by <fields>",
      "Comma-separated sort fields: successfulJobCount, successRate, uniqueBuyerCount, minsFromLastOnlineTime"
    )
    .option("--top-k <n>", "Max number of results", parseInt)
    .option(
      "--online <status>",
      "Filter by online status: all, online, offline"
    )
    .option("--cluster <name>", "Filter by cluster")
    .option("--legacy", "Search legacy (openclaw-cli) agents instead of v2")
    .action(async (query, opts, cmd) => {
      if (!query) {
        console.log("Please provide a query to browse agents.");
        return;
      }

      const json = isJson(cmd);

      try {
        if (opts.legacy) {
          // Search legacy agents via old AcpClient.browseAgents
          const adapter = await createLegacyBuyerAdapter();
          const agents = await adapter.browse(query, {
            topK: opts.topK,
            cluster: opts.cluster,
            onlineStatus: opts.online,
          });

          if (json) {
            const data = agents.map((a) => ({
              name: a.name,
              walletAddress: a.walletAddress,
              description: a.description ?? "",
              offerings: a.jobOfferings.map((o) => ({
                name: o.name,
                priceValue: o.price,
                priceType: o.priceType,
                requirements: o.requirement,
                deliverable: o.deliverable,
                slaMinutes: o.slaMinutes,
                requiredFunds: o.requiredFunds,
              })),
              chainId: adapter.chainId,
              legacy: true,
            }));
            process.stdout.write(JSON.stringify({ data }) + "\n");
            return;
          }

          if (agents.length === 0) {
            console.log("No legacy agents found.");
            return;
          }

          if (isTTY()) {
            for (const a of agents) {
              printLegacyAgent(a, adapter.chainId);
            }
            console.log(`\n${agents.length} legacy agent(s) found.`);
          } else {
            console.log("NAME\tWALLET\tOFFERINGS");
            for (const a of agents) {
              console.log(
                `${a.name}\t${a.walletAddress}\t${a.jobOfferings.length}`
              );
            }
          }
          return;
        }

        // Default: search agents via v2 SDK
        const agent = await createAgentFromConfig();

        const sortBy = opts.sortBy
          ? opts.sortBy.split(",").map((s: string) => s.trim())
          : undefined;

        const data = await agent.browseAgents(query, {
          sortBy,
          topK: opts.topK,
          isOnline: opts.online,
          cluster: opts.cluster,
        });

        if (json) {
          process.stdout.write(JSON.stringify({ data }) + "\n");
          return;
        }

        if (data.length === 0) {
          console.log("No agents found.");
          return;
        }

        if (isTTY()) {
          for (const a of data) {
            console.log(`  ${c.bold("Name:")}           ${c.cyan(a.name)}`);
            console.log(`  ${c.bold("Description:")}    ${a.description}`);
            console.log(`  ${c.bold("Wallet:")}         ${c.dim(a.walletAddress)}`);
            if (a.chains.length > 0) {
              console.log(
                `  ${c.bold("Chains:")}         ${a.chains.map((ch) => ch.chainId).join(", ")}`
              );
            }
            if (a.offerings.length > 0) {
              console.log(`  ${c.bold("Offerings:")}`);
              for (const o of a.offerings) {
                printOffering(o);
              }
            } else {
              console.log(`  ${c.bold("Offerings:")}      ${c.dim("No offerings")}`);
            }
            if (a.resources.length > 0) {
              console.log(`  ${c.bold("Resources:")}`);
              for (const r of a.resources) {
                printResource(r);
              }
            } else {
              console.log(`  ${c.bold("Resources:")}      ${c.dim("No resources")}`);
            }
            console.log("");
          }
          console.log(`\n${c.dim(`${data.length} agent(s) found.`)}`);
        } else {
          console.log("NAME\tWALLET\tOFFERINGS\tRESOURCES");
          for (const a of data) {
            console.log(
              `${a.name}\t${a.walletAddress}\t${a.offerings.length}\t${a.resources.length}`
            );
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
