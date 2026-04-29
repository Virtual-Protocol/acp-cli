import { createServer } from "http";
import { dirname, resolve as resolvePath } from "path";
import { homedir } from "os";
import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import { loadHandlers, type LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering, HandlerInput, ServeProtocol } from "../types";
import { serviceJobEndpoint, startServiceJobRelay } from "./relay";

export interface ServerOptions {
  dir: string;
  port?: number;
  agentSlug: string;
  providerWallet: string;
  offering: DeployedOffering["offering"];
  protocols?: ServeProtocol[];
  settle8183?: boolean;
  apiUrl?: string;
  agentToken?: string;
  sandbox?: boolean;
}

export async function startOfferingServer(
  options: ServerOptions,
): Promise<void> {
  const { dir, providerWallet, offering } = options;
  const protocols = options.protocols ?? ["x402", "mpp", "acp"];
  const port = options.port ?? 3000;
  const apiUrl = options.apiUrl ?? process.env.ACP_API_URL;
  const settle8183 = options.settle8183 ?? false;

  let handlers = await loadHandlers(dir);
  if (options.sandbox) {
    const { runInSandbox } = await import("../runtime/sandbox");
    const handlerPath = resolvePath(dir, "handler.ts");
    const timeoutMs = Math.max(offering.slaMinutes, 1) * 60_000;
    handlers = {
      ...handlers,
      handler: (input) => runInSandbox(handlerPath, input, timeoutMs),
    };
  }

  const deployed: DeployedOffering = {
    offeringId: offering.id,
    agentSlug: options.agentSlug,
    providerWallet,
    offering,
    hasBudgetHandler: Boolean(handlers.budgetHandler),
    protocols,
    evaluator: "self",
    settle8183,
  };

  const usesRelay = protocols.includes("x402") || protocols.includes("mpp");
  if (usesRelay && settle8183) {
    throw new Error(
      "--settle-8183 is reserved but not supported until ERC-8183 supports this flow.",
    );
  }
  if (usesRelay && (!apiUrl || !options.agentToken)) {
    throw new Error(
      "ACP API URL and agent auth token are required for x402/MPP.",
    );
  }

  const relay =
    usesRelay && apiUrl && options.agentToken
      ? startServiceJobRelay(deployed, handlers, {
          apiUrl,
          agentToken: options.agentToken,
        })
      : undefined;

  if (protocols.includes("acp")) {
    startACPListener(deployed, handlers).catch((err) => {
      console.error(`[ACP] Native listener failed: ${err.message ?? err}`);
    });
  }

  const pidFile = getPidFilePath(offering.id);
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid));

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          status: "ok",
          offering: { id: offering.id, name: offering.name },
          protocols,
          relay: usesRelay ? "enabled" : "disabled",
          pid: process.pid,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("Not found");
  });

  server.listen(port, () => {
    const offeringSlug = offering.slug || offering.id;
    console.log(`\nACP Serve runtime running on port ${port}\n`);
    console.log(`Offering: ${offering.name} (${offering.id})`);
    console.log(`Provider: ${providerWallet}`);
    console.log("Mode: BE-mediated service-job runtime");
    console.log(`Settlement: ${settle8183 ? "ERC-8183" : "direct x402/MPP"}`);
    console.log("\nEndpoints:");
    if (apiUrl && protocols.includes("x402")) {
      console.log(
        `  x402: ${serviceJobEndpoint(apiUrl, providerWallet, offeringSlug, "x402")}`,
      );
    }
    if (apiUrl && protocols.includes("mpp")) {
      console.log(
        `  MPP:  ${serviceJobEndpoint(apiUrl, providerWallet, offeringSlug, "mpp")}`,
      );
    }
    if (protocols.includes("acp")) console.log("  ACP:  native listener");
    console.log(`\nHealth: http://localhost:${port}/health`);
  });

  const shutdown = () => {
    relay?.disconnect();
    server.close();
    try {
      unlinkSync(pidFile);
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startACPListener(
  offering: DeployedOffering,
  handlers: LoadedHandlers,
): Promise<void> {
  const { createAgentFromConfig } = await import("../../src/lib/agentFactory");
  const { AssetToken } = await import("@virtuals-protocol/acp-node-v2");
  const agent = await createAgentFromConfig();
  const chainId = Number(process.env.ACP_CHAIN_ID || "84532");
  const jobRequirements = new Map<string, Record<string, unknown> | string>();

  agent.on("entry", async (session: any, entry: any) => {
    const jobId = session.jobId;
    try {
      const status = session.status;

      if (entry.contentType === "requirement" && entry.content) {
        try {
          jobRequirements.set(jobId, JSON.parse(entry.content));
        } catch {
          jobRequirements.set(jobId, entry.content);
        }
      }

      if (status === "open" && jobRequirements.has(jobId)) {
        const requirements = jobRequirements.get(jobId)!;
        const input = buildHandlerInput(
          offering,
          requirements,
          entry.from || "unknown",
          "acp",
          jobId,
        );
        if (handlers.budgetHandler) {
          const budget = await handlers.budgetHandler(input);
          if (budget.fundRequest) {
            await session.setBudgetWithFundRequest(
              AssetToken.usdc(budget.amount, chainId),
              AssetToken.usdc(budget.fundRequest.transferAmount, chainId),
              budget.fundRequest.destination,
            );
          } else {
            await session.setBudget(AssetToken.usdc(budget.amount, chainId));
          }
        } else {
          await session.setBudget(
            AssetToken.usdc(offering.offering.priceValue, chainId),
          );
        }
      }

      if (status === "funded" && jobRequirements.has(jobId)) {
        const result = await handlers.handler(
          buildHandlerInput(
            offering,
            jobRequirements.get(jobId)!,
            entry.from || "unknown",
            "acp",
            jobId,
          ),
        );
        await session.submit(result.deliverable);
      }

      if (["completed", "rejected", "expired"].includes(status)) {
        jobRequirements.delete(jobId);
      }
    } catch (err) {
      console.error(
        `[ACP] Failed to process job ${jobId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });

  await agent.start();
}

function buildHandlerInput(
  offering: DeployedOffering,
  requirements: Record<string, unknown> | string,
  clientAddress: string,
  protocol: HandlerInput["protocol"],
  jobId?: string,
): HandlerInput {
  return {
    requirements,
    offering: offering.offering,
    jobId,
    client: { address: clientAddress },
    protocol,
  };
}

export function getPidFilePath(offeringId: string): string {
  return resolvePath(homedir(), ".acp", "serve", `${offeringId}.pid`);
}
