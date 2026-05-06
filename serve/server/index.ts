import { createServer } from "http";
import { dirname, resolve as resolvePath } from "path";
import { homedir } from "os";
import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import { loadHandlers, type LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering, HandlerInput, ServeProtocol } from "../types";
import {
  serviceJobEndpoint,
  startServiceJobRelay,
  type ServiceJobRelayOptions,
} from "./relay";
import type { Socket } from "socket.io-client";
import { base } from "viem/chains";

export interface RuntimeOffering {
  dir: string;
  offering: DeployedOffering["offering"];
  protocols?: ServeProtocol[];
}

export interface ServerOptions {
  port?: number;
  agentSlug: string;
  providerWallet: string;
  offerings: RuntimeOffering[];
  resolveOffering: (offeringId: string) => Promise<HandlerInput["offering"]>;
  settle8183?: boolean;
  apiUrl?: string;
  agentToken?: string;
  sandbox?: boolean;
}

interface PreparedOffering {
  deployed: DeployedOffering;
  handlers: LoadedHandlers;
  protocols: ServeProtocol[];
}

export async function startOfferingsServer(
  options: ServerOptions,
): Promise<void> {
  const { providerWallet, agentSlug } = options;
  const port = options.port ?? 3000;
  const apiUrl = options.apiUrl ?? process.env.ACP_API_URL;
  const settle8183 = options.settle8183 ?? false;

  if (options.offerings.length === 0) {
    throw new Error("No offerings to serve.");
  }

  const prepared: PreparedOffering[] = [];
  for (const entry of options.offerings) {
    const protocols = entry.protocols ?? ["x402", "mpp", "acp"];
    let handlers = await loadHandlers(entry.dir);
    if (options.sandbox) {
      const { runInSandbox } = await import("../runtime/sandbox");
      const handlerPath = resolvePath(entry.dir, "handler.ts");
      const timeoutMs = Math.max(entry.offering.slaMinutes, 1) * 60_000;
      handlers = {
        ...handlers,
        handler: (input) => runInSandbox(handlerPath, input, timeoutMs),
      };
    }

    prepared.push({
      deployed: {
        offeringId: entry.offering.id,
        agentSlug,
        providerWallet,
        offering: entry.offering,
        hasBudgetHandler: Boolean(handlers.budgetHandler),
        protocols,
        evaluator: "self",
        settle8183,
      },
      handlers,
      protocols,
    });
  }

  const anyUsesRelay = prepared.some(
    (p) => p.protocols.includes("x402") || p.protocols.includes("mpp"),
  );
  if (anyUsesRelay && settle8183) {
    throw new Error(
      "--settle-8183 is reserved but not supported until ERC-8183 supports this flow.",
    );
  }
  if (anyUsesRelay && (!apiUrl || !options.agentToken)) {
    throw new Error(
      "ACP API URL and agent auth token are required for x402/MPP.",
    );
  }

  const relays: Socket[] = [];
  if (apiUrl && options.agentToken) {
    const relayOptions: ServiceJobRelayOptions = {
      apiUrl,
      agentToken: options.agentToken,
      resolveOffering: options.resolveOffering,
    };
    for (const p of prepared) {
      if (p.protocols.includes("x402") || p.protocols.includes("mpp")) {
        relays.push(startServiceJobRelay(p.deployed, p.handlers, relayOptions));
      }
    }
  }

  const acpOfferings = prepared.filter((p) => p.protocols.includes("acp"));
  if (acpOfferings.length > 0) {
    startSharedACPListener(acpOfferings, options.resolveOffering).catch(
      (err) => {
        console.error(`[ACP] Native listener failed: ${err.message ?? err}`);
      },
    );
  }

  const pidFile = getRuntimePidFilePath(providerWallet);
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid));

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          status: "ok",
          provider: providerWallet,
          pid: process.pid,
          offerings: prepared.map((p) => ({
            id: p.deployed.offering.id,
            name: p.deployed.offering.name,
            protocols: p.protocols,
            relay:
              p.protocols.includes("x402") || p.protocols.includes("mpp")
                ? "enabled"
                : "disabled",
          })),
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("Not found");
  });

  server.listen(port, () => {
    console.log(`\nACP Serve runtime running on port ${port}\n`);
    console.log(`Provider: ${providerWallet}`);
    console.log("Mode: BE-mediated service-job runtime");
    console.log(`Settlement: ${settle8183 ? "ERC-8183" : "direct x402/MPP"}`);
    console.log(`\nServing ${prepared.length} offering(s):`);
    for (const p of prepared) {
      const offeringSlug = p.deployed.offering.slug || p.deployed.offering.id;
      console.log(`\n  ${p.deployed.offering.name} (${p.deployed.offering.id})`);
      if (apiUrl && p.protocols.includes("x402")) {
        console.log(
          `    x402: ${serviceJobEndpoint(
            apiUrl,
            providerWallet,
            offeringSlug,
            "x402",
          )}`,
        );
      }
      if (apiUrl && p.protocols.includes("mpp")) {
        console.log(
          `    MPP:  ${serviceJobEndpoint(
            apiUrl,
            providerWallet,
            offeringSlug,
            "mpp",
          )}`,
        );
      }
      if (p.protocols.includes("acp")) console.log("    ACP:  native listener");
    }
    console.log(`\nHealth: http://localhost:${port}/health`);
  });

  const shutdown = () => {
    for (const relay of relays) relay.disconnect();
    server.close();
    try {
      unlinkSync(pidFile);
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startSharedACPListener(
  offerings: PreparedOffering[],
  resolveOffering: (offeringId: string) => Promise<HandlerInput["offering"]>,
): Promise<void> {
  const { createAgentFromConfig } = await import("../../src/lib/agentFactory");
  const { AssetToken } = await import("@virtuals-protocol/acp-node-v2");
  const agent = await createAgentFromConfig();
  const chainId = Number(process.env.ACP_CHAIN_ID || base.id);
  const jobRequirements = new Map<string, Record<string, unknown> | string>();

  agent.on("entry", async (session: any, entry: any) => {
    const jobId = session.jobId;
    try {
      const match = await findOfferingForSession(offerings, session);
      if (!match) return;
      const liveOffering = await resolveOffering(match.deployed.offeringId);
      const liveDeployed: DeployedOffering = {
        ...match.deployed,
        offering: liveOffering,
        offeringId: liveOffering.id,
      };

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
          liveDeployed,
          requirements,
          entry.from || "unknown",
          "acp",
          jobId,
        );
        if (match.handlers.budgetHandler) {
          const budget = await match.handlers.budgetHandler(input);
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
            AssetToken.usdc(liveOffering.priceValue, chainId),
          );
        }
      }

      if (status === "funded" && jobRequirements.has(jobId)) {
        const result = await match.handlers.handler(
          buildHandlerInput(
            liveDeployed,
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

async function findOfferingForSession(
  offerings: PreparedOffering[],
  session: any,
): Promise<PreparedOffering | undefined> {
  const job = session.job ?? (await session.fetchJob());
  const providerAddress = String(job.providerAddress ?? "").toLowerCase();
  const description = String(job.description ?? "");
  for (const o of offerings) {
    if (providerAddress !== o.deployed.providerWallet.toLowerCase()) continue;
    const off = o.deployed.offering;
    if (
      description === off.name ||
      description === off.id ||
      description === off.slug
    ) {
      return o;
    }
  }
  return undefined;
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

export function getRuntimePidFilePath(providerWallet: string): string {
  return resolvePath(
    homedir(),
    ".acp",
    "serve",
    `${providerWallet.toLowerCase()}.pid`,
  );
}
