import type { Command } from "commander";
import { isJson, outputError, isTTY } from "../lib/output";
import { getClient } from "../lib/api/client";
import type { BrowseAgent } from "../lib/api/agent";
import { detectProtocolVersion } from "../lib/compat/versionDetector";

type Offering = BrowseAgent["offerings"][number];
type Resource = BrowseAgent["resources"][number];

function formatPrice(priceType: string, priceValue: string): string {
  if (priceType.toUpperCase() === "FIXED") {
    return `${parseFloat(priceValue)} USDC`;
  }
  if (priceType.toUpperCase() === "PERCENTAGE") {
    return `${parseFloat((parseFloat(priceValue) * 100).toFixed(2))}%`;
  }
  return `${priceValue} (${priceType})`;
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
}

function printResource(r: Resource): void {
  console.log(`    - ${r.name}`);
  console.log(`      Description:   ${r.description}`);
  console.log(`      Params:        ${formatOneLiner(r.params)}`);
  console.log(`      URL:           ${r.url}`);
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
    .action(async (query, opts, cmd) => {
      if (!query) {
        console.log("Please provide a query to browse agents.");
        return;
      }

      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const chainIds = opts.chainIds
        ? opts.chainIds.split(",").map((id: string) => parseInt(id.trim(), 10))
        : undefined;

      const sortBy = opts.sortBy
        ? opts.sortBy.split(",").map((s: string) => s.trim())
        : undefined;

      try {
        const result = await agentApi.browse(query, chainIds, {
          sortBy,
          topK: opts.topK,
          isOnline: opts.online,
          cluster: opts.cluster,
        });

        const { data } = result;

        if (json) {
          const enriched = data.map((a) => ({
            ...a,
            protocolVersion: detectProtocolVersion(a),
          }));
          process.stdout.write(JSON.stringify({ data: enriched }) + "\n");
          return;
        }

        if (data.length === 0) {
          console.log("No agents found.");
          return;
        }

        if (isTTY()) {
          for (const a of data) {
            const version = detectProtocolVersion(a);
            console.log(`  Name:           ${a.name} [${version}]`);
            console.log(`  Description:    ${a.description}`);
            console.log(`  Wallet:         ${a.walletAddress}`);
            if (a.chains.length > 0) {
              console.log(
                `  Chains:         ${a.chains.map((c) => c.chainId).join(", ")}`
              );
            }
            if (a.offerings.length > 0) {
              console.log(`  Offerings:`);
              for (const o of a.offerings) {
                printOffering(o);
              }
            } else {
              console.log(`  Offerings:      No offerings`);
            }
            if (a.resources.length > 0) {
              console.log(`  Resources:`);
              for (const r of a.resources) {
                printResource(r);
              }
            } else {
              console.log(`  Resources:      No resources`);
            }
            console.log("");
          }
          console.log(`\n${data.length} agent(s) found.`);
        } else {
          console.log("NAME\tWALLET\tOFFERINGS\tRESOURCES");
          for (const a of data) {
            console.log(
              `${a.name}\t${a.walletAddress}\t${a.offerings.length}\t${a.resources.length}`
            );
          }
        }
      } catch (err) {
        outputError(
          json,
          err instanceof Error ? err : String(err)
        );
      }
    });
}
