import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  watchFile,
  statSync,
  readdirSync,
} from "fs";
import { homedir } from "os";
import type { Command } from "commander";
import { isJson, outputError, outputResult } from "../lib/output";
import { getActiveWallet, getAgentId, getAgentToken } from "../lib/config";
import { getApiUrl, getClient } from "../lib/api/client";
import type { Agent, AgentOffering } from "../lib/api/agent";
import { provisionDeploySigner } from "../lib/deploySigner";
import type { DeployProviderName } from "../../serve/providers/types";
import { RailwayDeployProvider } from "../../serve/providers/railway";
import { CloudflareDeployProvider } from "../../serve/providers/cloudflare";

type Protocol = "x402" | "mpp" | "acp";

type LocalOfferingConfig = {
  slug: string;
  dir: string;
  protocols: Protocol[];
  offeringJson: Record<string, unknown>;
};

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function getServeConfigPath(rootDir: string): string {
  return resolve(rootDir, "serve.json");
}

function requireActiveAgent(json: boolean): { wallet: string; agentId: string } | null {
  const wallet = getActiveWallet();
  if (!wallet) {
    outputError(json, "No active agent set. Run `acp agent use` first.");
    return null;
  }
  const agentId = getAgentId(wallet);
  if (!agentId) {
    outputError(json, "Agent ID not found. Run `acp agent use` first.");
    return null;
  }
  return { wallet, agentId };
}

function loadLocalOfferings(rootDir: string, agentId: string): LocalOfferingConfig[] {
  const serveConfigPath = getServeConfigPath(rootDir);
  if (!existsSync(serveConfigPath)) {
    throw new Error(`serve.json not found in ${rootDir}. Run \`acp serve init\` first.`);
  }

  const serveConfig = readJsonFile(serveConfigPath);
  const agents = (serveConfig.agents ?? {}) as Record<
    string,
    { name?: string; offerings?: Record<string, { dir: string; protocols?: Protocol[] }> }
  >;
  const agentConfig = agents[agentId];
  if (!agentConfig?.offerings) {
    return [];
  }

  const results: LocalOfferingConfig[] = [];
  for (const [slug, entry] of Object.entries(agentConfig.offerings)) {
    const dir = resolve(rootDir, entry.dir);
    const offeringJsonPath = resolve(dir, "offering.json");
    const offeringJson = existsSync(offeringJsonPath) ? readJsonFile(offeringJsonPath) : {};
    results.push({
      slug,
      dir,
      protocols: entry.protocols ?? ["x402", "mpp", "acp"],
      offeringJson,
    });
  }

  return results;
}

function selectLocalOfferings(
  offerings: LocalOfferingConfig[],
  selector?: string
): LocalOfferingConfig[] {
  if (!selector) {
    return offerings;
  }

  const normalized = selector.trim().toLowerCase();
  return offerings.filter((entry) => {
    const id = typeof entry.offeringJson.id === "string" ? entry.offeringJson.id : "";
    const name =
      typeof entry.offeringJson.name === "string" ? entry.offeringJson.name : "";
    return (
      entry.slug.toLowerCase() === normalized ||
      id.toLowerCase() === normalized ||
      name.toLowerCase() === normalized
    );
  });
}

function findRemoteOffering(
  local: LocalOfferingConfig,
  agent: Agent
): AgentOffering | undefined {
  const localId =
    typeof local.offeringJson.id === "string" ? local.offeringJson.id : undefined;
  if (localId) {
    return agent.offerings.find((offering) => offering.id === localId);
  }

  const localName =
    typeof local.offeringJson.name === "string" ? local.offeringJson.name : undefined;
  if (!localName) {
    return undefined;
  }

  const matches = agent.offerings.filter((offering) => offering.name === localName);
  if (matches.length === 1) {
    return matches[0];
  }
  return undefined;
}

function materializeOffering(
  local: LocalOfferingConfig,
  remote: AgentOffering | undefined
): {
  id: string;
  slug: string;
  name: string;
  description: string;
  priceType: string;
  priceValue: number;
  slaMinutes: number;
  requirements: Record<string, unknown> | string;
  deliverable: Record<string, unknown> | string;
} {
  const localName =
    typeof local.offeringJson.name === "string" ? local.offeringJson.name : local.slug;
  const localDescription =
    typeof local.offeringJson.description === "string"
      ? local.offeringJson.description
      : "";
  const localPriceType =
    typeof local.offeringJson.priceType === "string"
      ? local.offeringJson.priceType
      : "fixed";
  const localPriceValue =
    typeof local.offeringJson.priceValue === "number"
      ? local.offeringJson.priceValue
      : Number(local.offeringJson.priceValue ?? 0);
  const localSla =
    typeof local.offeringJson.slaMinutes === "number"
      ? local.offeringJson.slaMinutes
      : Number(local.offeringJson.slaMinutes ?? 5);

  return {
    id:
      remote?.id ??
      (typeof local.offeringJson.id === "string" ? local.offeringJson.id : local.slug),
    slug: local.slug,
    name: remote?.name ?? localName,
    description: remote?.description ?? localDescription,
    priceType: remote?.priceType ?? localPriceType,
    priceValue: remote ? Number(remote.priceValue) : localPriceValue,
    slaMinutes: remote?.slaMinutes ?? localSla,
    requirements:
      remote?.requirements ??
      ((local.offeringJson.requirements as Record<string, unknown> | string) ?? ""),
    deliverable:
      remote?.deliverable ??
      ((local.offeringJson.deliverable as Record<string, unknown> | string) ?? ""),
  };
}

function getDefaultPort(input: unknown): number {
  const port = Number(input ?? 3000);
  return Number.isFinite(port) && port > 0 ? port : 3000;
}

function serviceJobEndpoint(
  apiUrl: string,
  providerAddress: string,
  offeringSlug: string,
  protocol: "x402" | "mpp"
): string {
  return new URL(
    `/${protocol}/${providerAddress}/jobs/${encodeURIComponent(offeringSlug)}`,
    apiUrl
  ).toString();
}

export function registerServeCommands(program: Command): void {
  const serve = program
    .command("serve")
    .description("Scaffold, run, and deploy ACP service endpoints");

  serve
    .command("init")
    .description("Scaffold a local offering runtime for an agent offering")
    .requiredOption("--name <name>", "Offering name")
    .option("--output <dir>", "Project root directory", ".")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const active = requireActiveAgent(json);
        if (!active) return;

        const rootDir = resolve(opts.output);
        const { agentApi } = await getClient();
        const agent = await agentApi.getById(active.agentId);
        const agentSlug = slugify(agent.name);
        const offeringSlug = slugify(opts.name);
        const offeringDir = resolve(
          rootDir,
          "agents",
          agentSlug,
          "offerings",
          offeringSlug
        );

        if (existsSync(resolve(offeringDir, "handler.ts"))) {
          throw new Error(
            `Handler already exists at ${offeringDir}. Delete it or choose a different name.`
          );
        }

        mkdirSync(offeringDir, { recursive: true });

        const scaffoldDir = resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../../serve/scaffold"
        );
        const offeringTemplate = readFileSync(
          resolve(scaffoldDir, "offering.json.template"),
          "utf8"
        );
        const offeringJson = JSON.parse(
          offeringTemplate.replace("{{NAME}}", opts.name)
        ) as Record<string, unknown>;

        writeFileSync(
          resolve(offeringDir, "offering.json"),
          JSON.stringify(offeringJson, null, 2) + "\n"
        );
        writeFileSync(
          resolve(offeringDir, "handler.ts"),
          readFileSync(resolve(scaffoldDir, "handler.ts.template"), "utf8")
        );
        writeFileSync(
          resolve(offeringDir, "budget.ts"),
          readFileSync(resolve(scaffoldDir, "budget.ts.template"), "utf8")
        );

        const serveConfigPath = getServeConfigPath(rootDir);
        const serveConfig = existsSync(serveConfigPath)
          ? readJsonFile(serveConfigPath)
          : { agents: {}, evaluator: "self", port: 3000 };

        const agents = (serveConfig.agents ?? {}) as Record<string, unknown>;
        const agentConfig = (agents[active.agentId] ?? {
          name: agent.name,
          offerings: {},
        }) as Record<string, unknown>;
        const offerings = (agentConfig.offerings ?? {}) as Record<string, unknown>;
        offerings[offeringSlug] = {
          dir: `agents/${agentSlug}/offerings/${offeringSlug}`,
          protocols: ["x402", "mpp", "acp"],
          registered: false,
        };
        agentConfig.offerings = offerings;
        agents[active.agentId] = agentConfig;
        serveConfig.agents = agents;

        writeFileSync(
          serveConfigPath,
          JSON.stringify(serveConfig, null, 2) + "\n"
        );

        outputResult(json, {
          success: true,
          offering: opts.name,
          directory: offeringDir,
        });
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  serve
    .command("start")
    .description("Start the local runtime for a single offering")
    .option("--dir <path>", "Project root directory", ".")
    .option("--offering <selector>", "Offering slug, ID, or name")
    .option("--port <number>", "Port to listen on")
    .option("--settle-8183", "Enable on-chain ERC-8183 settlement for x402/MPP")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const active = requireActiveAgent(json);
        if (!active) return;

        const rootDir = resolve(opts.dir);
        const localOfferings = loadLocalOfferings(rootDir, active.agentId);
        const selected = selectLocalOfferings(localOfferings, opts.offering);

        if (selected.length === 0) {
          throw new Error("No matching offerings found in serve.json.");
        }
        if (selected.length > 1) {
          throw new Error(
            "Multiple offerings matched. Rerun with --offering <slug|id|name>."
          );
        }

        const { agentApi } = await getClient(active.wallet);
        const agent = await agentApi.getById(active.agentId);
        const agentToken = getAgentToken(active.wallet);
        if (!agentToken) {
          throw new Error("Agent auth token not found. Run `acp agent use` first.");
        }
        const agentSlug = slugify(agent.name);
        const local = selected[0];
        const remote = findRemoteOffering(local, agent);
        const offering = materializeOffering(local, remote);

        const { startOfferingServer } = await import("../../serve/server/index");
        await startOfferingServer({
          dir: local.dir,
          port: opts.port ? Number(opts.port) : getDefaultPort(undefined),
          agentSlug,
          providerWallet: active.wallet,
          offering,
          protocols: local.protocols,
          settle8183: opts.settle8183 === true,
          apiUrl: getApiUrl(),
          agentToken,
        });
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  serve
    .command("endpoints")
    .description("Show canonical BE endpoint URLs for configured offerings")
    .option("--dir <path>", "Project root directory", ".")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const active = requireActiveAgent(json);
        if (!active) return;

        const rootDir = resolve(opts.dir);
        const offerings = loadLocalOfferings(rootDir, active.agentId);
        const apiUrl = getApiUrl();
        const payload: Record<string, Record<string, string>> = {};

        for (const offering of offerings) {
          payload[offering.slug] = {};
          if (offering.protocols.includes("x402")) {
            payload[offering.slug].x402 = serviceJobEndpoint(
              apiUrl,
              active.wallet,
              offering.slug,
              "x402"
            );
          }
          if (offering.protocols.includes("mpp")) {
            payload[offering.slug].mpp = serviceJobEndpoint(
              apiUrl,
              active.wallet,
              offering.slug,
              "mpp"
            );
          }
          if (offering.protocols.includes("acp")) {
            payload[offering.slug].acp = "native ACP listener";
          }
        }

        outputResult(json, { endpoints: payload });
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  serve
    .command("deploy")
    .description("Build a deploy bundle and deploy it through a provider adapter")
    .option("--dir <path>", "Project root directory", ".")
    .option("--provider <name>", "Deployment provider: railway or cloudflare", "railway")
    .option("--offering <selector>", "Offering slug, ID, or name")
    .option("--service <name>", "Provider service name override")
    .option("--project <name>", "Provider project identifier")
    .option("--environment <name>", "Provider environment identifier")
    .option("--domain <domain>", "Custom domain (e.g. serve.virtuals.io)")
    .option("--execute", "Execute provider CLI commands when supported")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const active = requireActiveAgent(json);
        if (!active) return;

        const providerName = opts.provider as DeployProviderName;
        if (providerName !== "railway" && providerName !== "cloudflare") {
          throw new Error("Unsupported provider. Use `railway` or `cloudflare`.");
        }

        const rootDir = resolve(opts.dir);
        const localOfferings = loadLocalOfferings(rootDir, active.agentId);
        const selected = selectLocalOfferings(localOfferings, opts.offering);
        if (selected.length === 0) {
          throw new Error("No matching offerings found in serve.json.");
        }

        const { agentApi } = await getClient();
        const agent = await agentApi.getById(active.agentId);
        const provider =
          providerName === "railway"
            ? new RailwayDeployProvider()
            : new CloudflareDeployProvider();

        const results: Record<string, unknown>[] = [];
        for (const local of selected) {
          const remote = findRemoteOffering(local, agent);
          if (!remote) {
            throw new Error(
              `Offering "${local.slug}" is not registered on ACP yet. Run \`acp offering create --from-file ${resolve(
                local.dir,
                "offering.json"
              )}\` first.`
            );
          }

          const offering = materializeOffering(local, remote);
          const deploySigner = await provisionDeploySigner(
            agentApi,
            agent,
            offering.name,
            (message) => {
              if (!json) {
                console.log(message);
              }
            }
          );

          const walletId = agent.walletProviders?.[0]?.metadata?.walletId;
          if (!walletId) {
            throw new Error("Wallet ID not found for agent. Cannot deploy.");
          }

          const deployment = await provider.deploy(
            {
              rootDir,
              serviceName: opts.service ?? `${slugify(agent.name)}-${local.slug}`,
              providerWallet: active.wallet,
              agentId: active.agentId,
              agentName: agent.name,
              apiUrl: getApiUrl(),
              walletId,
              offering,
              entryDir: local.dir,
              protocols: local.protocols,
              deploySigner: {
                publicKey: deploySigner.publicKey,
                privateKey: deploySigner.privateKey,
              },
            },
            {
              project: opts.project,
              environment: opts.environment,
              service: opts.service,
              domain: opts.domain,
              execute: opts.execute === true,
            }
          );

          results.push({
            offering: local.slug,
            provider: deployment.provider,
            bundleDir: deployment.bundleDir,
            executed: deployment.executed,
            serviceName: deployment.serviceName,
            endpoints: deployment.endpoints,
            nextSteps: deployment.nextSteps,
            deploySignerPublicKey: deploySigner.publicKey,
            signerApprovalUrl: deploySigner.signerUrl,
          });
        }

        outputResult(json, { deployments: results });
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  serve
    .command("undeploy")
    .description("Placeholder for managed undeploy support")
    .requiredOption("--offering <selector>", "Offering slug, ID, or name")
    .action(async (_opts, cmd) => {
        outputError(
          isJson(cmd),
        "Undeploy is not implemented yet. Remove the managed deployment from the hosting control plane for now."
        );
    });

  serve
    .command("stop")
    .description("Stop a locally running offering server")
    .option("--dir <path>", "Project root directory", ".")
    .option("--offering <selector>", "Offering slug, ID, or name")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const active = requireActiveAgent(json);
        if (!active) return;

        const rootDir = resolve(opts.dir);
        const selected = selectLocalOfferings(
          loadLocalOfferings(rootDir, active.agentId),
          opts.offering
        );

        let stopped = 0;
        const { getPidFilePath } = await import("../../serve/server/index");
        for (const local of selected) {
          const offeringId =
            typeof local.offeringJson.id === "string"
              ? local.offeringJson.id
              : local.slug;
          const pidFile = getPidFilePath(offeringId);
          if (!existsSync(pidFile)) continue;
          const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
          try {
            process.kill(pid, "SIGTERM");
            stopped += 1;
          } catch {
            // Ignore stale pid files.
          }
        }

        outputResult(json, { success: true, stopped });
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  serve
    .command("status")
    .description("Show whether local offering servers are running")
    .option("--dir <path>", "Project root directory", ".")
    .option("--offering <selector>", "Offering slug, ID, or name")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const active = requireActiveAgent(json);
        if (!active) return;

        const rootDir = resolve(opts.dir);
        const selected = selectLocalOfferings(
          loadLocalOfferings(rootDir, active.agentId),
          opts.offering
        );

        const { getPidFilePath } = await import("../../serve/server/index");
        const statuses: Record<string, { running: boolean; pid?: number }> = {};
        for (const local of selected) {
          const offeringId =
            typeof local.offeringJson.id === "string"
              ? local.offeringJson.id
              : local.slug;
          const pidFile = getPidFilePath(offeringId);
          if (!existsSync(pidFile)) {
            statuses[local.slug] = { running: false };
            continue;
          }
          const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
          try {
            process.kill(pid, 0);
            statuses[local.slug] = { running: true, pid };
          } catch {
            statuses[local.slug] = { running: false };
          }
        }

        outputResult(json, { offerings: statuses });
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  serve
    .command("logs")
    .description("Read recent serve logs")
    .option("--offering <slug>", "Offering slug or ID")
    .option("--follow", "Tail logs in real time")
    .option("--level <level>", "Filter by log level")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const logDir = resolve(homedir(), ".acp", "serve", "logs");
        if (!existsSync(logDir)) {
          outputResult(json, { logs: [] });
          return;
        }

        const files = readdirSync(logDir)
          .filter((name) => name.endsWith(".log"))
          .filter((name) => !opts.offering || name === `${opts.offering}.log`)
          .map((name) => resolve(logDir, name));

        const logs: Record<string, unknown>[] = [];
        for (const file of files) {
          const contents = readFileSync(file, "utf8").trim();
          if (!contents) continue;
          for (const line of contents.split("\n")) {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (opts.level && parsed.level !== opts.level) continue;
              logs.push(parsed);
            } catch {
              // Ignore malformed lines.
            }
          }
        }

        logs.sort((a, b) =>
          String(a.timestamp).localeCompare(String(b.timestamp))
        );
        outputResult(json, { logs: logs.slice(-50) });

        if (opts.follow && files.length > 0 && !json) {
          console.log("Tailing logs. Ctrl+C to stop.");
          const offsets = new Map(files.map((file) => [file, statSync(file).size]));
          for (const file of files) {
            watchFile(file, { interval: 1000 }, () => {
              const currentSize = statSync(file).size;
              const previousSize = offsets.get(file) ?? 0;
              if (currentSize <= previousSize) return;
              const chunk = readFileSync(file, "utf8").slice(previousSize, currentSize);
              process.stdout.write(chunk);
              offsets.set(file, currentSize);
            });
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });
}
