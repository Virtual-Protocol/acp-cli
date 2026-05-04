/**
 * Offering Runtime
 *
 * Provider runtime deployed per offering.
 *
 * x402 and MPP public endpoints live on agentic-commerce-be. This process
 * keeps an outbound Socket.IO connection open so the BE can request payment
 * challenges and dispatch paid jobs without exposing provider infrastructure.
 *
 * ACP native runs as a background event listener in the same process.
 */

import { resolve as _resolve } from "path";
import { homedir as _homedir } from "os";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadHandlers, type LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering } from "../types";
import { serviceJobEndpoint, startServiceJobRelay } from "./relay";

export interface ServerOptions {
  dir: string;
  port?: number;
  agentSlug: string;
  providerWallet: string;
  offering: DeployedOffering["offering"];
  protocols?: ("x402" | "mpp" | "acp")[];
  /** When true, x402/MPP settle on-chain via ERC-8183 after payment.
   *  When false (default), settle direct x402/MPP → run handler → return result. */
  settle8183?: boolean;
  /** agentic-commerce-be API URL. x402/MPP clients call this URL, not the provider runtime. */
  apiUrl?: string;
  /** Agent auth token used by the provider runtime to connect to BE. */
  agentToken?: string;
  /** If true, run handlers in a sandboxed worker thread (no env access).
   *  Enabled automatically for hosted deployments to prevent handlers
   *  from accessing the deploy signer key. */
  sandbox?: boolean;
}

export async function startOfferingServer(
  options: ServerOptions,
): Promise<void> {
  const { dir, providerWallet, offering } = options;
  const protocols = options.protocols || ["x402", "mpp", "acp"];
  const port = options.port || 3000;

  let handlers = await loadHandlers(dir);

  // In sandbox mode, wrap the handler to run in an isolated worker thread.
  // The worker has NO access to process.env (no signer keys).
  // Enabled for hosted deployments to prevent handler code from stealing keys.
  if (options.sandbox) {
    const { runInSandbox } = await import("../runtime/sandbox");
    const { resolve } = await import("path");
    const handlerPath = resolve(dir, "handler.ts");
    const timeoutMs = (offering.slaMinutes || 5) * 60 * 1000;

    const originalHandler = handlers.handler;
    handlers = {
      ...handlers,
      handler: async (input) => {
        return runInSandbox(handlerPath, input, timeoutMs);
      },
    };
  }

  const agentSlug = options.agentSlug;
  const settle8183 = options.settle8183 ?? false;
  const apiUrl = options.apiUrl ?? process.env.ACP_API_URL;

  const deployed: DeployedOffering = {
    offeringId: offering.id,
    agentSlug,
    providerWallet,
    offering,
    hasBudgetHandler: !!handlers.budgetHandler,
    protocols,
    evaluator: "self",
    settle8183,
  };

  const app = new Hono();
  const offeringSlug = offering.slug || offering.id;

  const usesServiceJobRelay =
    protocols.includes("x402") || protocols.includes("mpp");
  if (usesServiceJobRelay && settle8183) {
    throw new Error(
      "--settle-8183 is reserved but not supported yet. Use direct x402/MPP service jobs until the ERC-8183 contract supports this flow.",
    );
  }

  let relay: ReturnType<typeof startServiceJobRelay> | undefined;
  if (usesServiceJobRelay) {
    if (!apiUrl) {
      throw new Error("ACP API URL is required for x402/MPP service jobs.");
    }
    if (!options.agentToken) {
      throw new Error(
        "Agent auth token is required for x402/MPP service jobs.",
      );
    }
    relay = startServiceJobRelay(deployed, handlers, {
      apiUrl,
      agentToken: options.agentToken,
    });
  }

  // Health check
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      offering: { id: offering.id, name: offering.name },
      protocols,
      relay: usesServiceJobRelay ? "enabled" : "disabled",
      pid: process.pid,
    }),
  );

  // 404
  app.all("*", (c) => c.json({ error: "Not found" }, 404));

  // Start ACP native listener (non-fatal — x402/mpp still serve if this fails)
  if (protocols.includes("acp")) {
    startACPListener(deployed, handlers).catch((err) => {
      console.error(
        `[ACP] Native listener failed to start: ${err.message ?? err}`,
      );
      console.error("[ACP] x402 and MPP relay is still available.");
    });
  }

  // Write PID file for serve stop/status
  const pidFile = getPidFilePath(offering.id);
  const { writeFileSync, mkdirSync } = await import("fs");
  const { dirname } = await import("path");
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid));

  // Start HTTP server
  serve({ fetch: app.fetch, port }, () => {
    console.log(`\nACP Serve running on port ${port}\n`);
    console.log(`Offering: ${offering.name} (${offering.id})`);
    console.log(`Provider: ${providerWallet}`);
    console.log(`PID: ${process.pid}\n`);
    console.log("Mode: BE-mediated service-job runtime");
    console.log(
      `Settlement: ${settle8183 ? "ERC-8183 (on-chain)" : "direct x402/MPP"}`,
    );
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
    if (protocols.includes("acp")) {
      console.log(`  ACP:  listening for events (native)`);
    }
    console.log(`\nHealth: http://localhost:${port}/health`);
  });

  // Cleanup on shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    relay?.disconnect();
    try {
      const { unlinkSync } = await import("fs");
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
  const { buildHandlerInput } = await import("./middleware/shared");

  const agent = await createAgentFromConfig();
  const CHAIN_ID = Number(process.env.ACP_CHAIN_ID || "84532");

  // Track jobs we're handling
  const jobRequirements = new Map<string, Record<string, unknown> | string>();

  agent.on("entry", async (session: any, entry: any) => {
    const jobId = session.jobId;
    const status = session.status;

    // Capture requirements from requirement messages
    if (entry.contentType === "requirement" && entry.content) {
      try {
        jobRequirements.set(jobId, JSON.parse(entry.content));
      } catch {
        jobRequirements.set(jobId, entry.content);
      }
    }

    // Job created + requirements received → propose budget
    if (status === "open" && jobRequirements.has(jobId)) {
      const requirements = jobRequirements.get(jobId)!;
      const input = buildHandlerInput(
        offering,
        requirements,
        entry.from || "unknown",
        "acp",
        jobId,
      );

      // Use budget handler if exists, otherwise offering's fixed price
      if (handlers.budgetHandler) {
        const budget = await handlers.budgetHandler(input);

        if (budget.fundRequest) {
          // Set budget with fund request (service fee + working capital)
          console.log(
            `[ACP] Job ${jobId}: setting budget ${budget.amount} USDC + fund request ${budget.fundRequest.transferAmount} USDC`,
          );
          await session.setBudgetWithFundRequest(
            AssetToken.usdc(budget.amount, CHAIN_ID),
            AssetToken.usdc(budget.fundRequest.transferAmount, CHAIN_ID),
            budget.fundRequest.destination,
          );
        } else {
          // Set budget only (service fee)
          console.log(
            `[ACP] Job ${jobId}: setting budget ${budget.amount} USDC`,
          );
          await session.setBudget(AssetToken.usdc(budget.amount, CHAIN_ID));
        }
      } else {
        // Default: use offering's fixed price
        const amount = offering.offering.priceValue;
        console.log(
          `[ACP] Job ${jobId}: setting budget ${amount} USDC (offering price)`,
        );
        await session.setBudget(AssetToken.usdc(amount, CHAIN_ID));
      }
    }

    // Job funded → run handler + submit
    if (status === "funded" && jobRequirements.has(jobId)) {
      const requirements = jobRequirements.get(jobId)!;
      const input = buildHandlerInput(
        offering,
        requirements,
        entry.from || "unknown",
        "acp",
        jobId,
      );

      console.log(`[ACP] Job ${jobId}: running handler...`);
      const result = await handlers.handler(input);

      console.log(`[ACP] Job ${jobId}: submitting deliverable`);
      await session.submit(result.deliverable);
    }

    // Terminal states — cleanup
    if (
      status === "completed" ||
      status === "rejected" ||
      status === "expired"
    ) {
      console.log(`[ACP] Job ${jobId}: ${status}`);
      jobRequirements.delete(jobId);
    }
  });

  await agent.start();
  console.log(`[ACP] Listening for native jobs: ${offering.offering.name}`);
}

/** PID file path for a given offering — used by stop/status commands */
export function getPidFilePath(offeringId: string): string {
  return _resolve(_homedir(), ".acp", "serve", `${offeringId}.pid`);
}
