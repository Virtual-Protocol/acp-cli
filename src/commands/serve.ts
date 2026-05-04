import { dirname, resolve } from "path";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { spawnSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  watchFile,
  writeFileSync,
} from "fs";
import type { Command } from "commander";
import type { Agent, AgentOffering } from "../lib/api/agent";
import { AuthApi } from "../lib/api/auth";
import { getApiUrl, getClient } from "../lib/api/client";
import {
  getActiveWallet,
  getAgentId,
  getAgentToken,
  getPublicKey,
  getWalletId,
} from "../lib/config";
import { isJson, outputError, outputResult } from "../lib/output";
import type { ServeProtocol } from "../../serve/types";
import { serviceJobEndpoint } from "../../serve/server/relay";

type LocalOfferingConfig = {
  slug: string;
  dir: string;
  protocols: ServeProtocol[];
  offeringJson: Record<string, unknown>;
};

type RailwayDeployOptions = {
  bundleDir: string;
  serviceName: string;
  project?: string;
  environment?: string;
  variables: Record<string, string | undefined>;
  agentToken: string;
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function getServeConfigPath(rootDir: string): string {
  return resolve(rootDir, "serve.json");
}

function getLocalAgentName(rootDir: string, agentId: string): string {
  const serveConfig = readJsonFile(getServeConfigPath(rootDir));
  const agents = (serveConfig.agents ?? {}) as Record<
    string,
    { name?: string }
  >;
  return agents[agentId]?.name ?? "agent";
}

function requireActiveAgent(json: boolean): {
  wallet: string;
  agentId: string;
} | null {
  const wallet = getActiveWallet();
  if (!wallet) {
    outputError(json, "No active agent set. Run `acp agent use` first.");
    return null;
  }

  const agentId = getAgentId(wallet);
  if (!agentId) {
    outputError(
      json,
      "Agent ID not found. Run `acp agent list` or `acp agent use` first.",
    );
    return null;
  }

  return { wallet, agentId };
}

function loadLocalOfferings(
  rootDir: string,
  agentId: string,
): LocalOfferingConfig[] {
  const serveConfigPath = getServeConfigPath(rootDir);
  if (!existsSync(serveConfigPath)) {
    throw new Error(
      `serve.json not found in ${rootDir}. Run \`acp serve init\` first.`,
    );
  }

  const serveConfig = readJsonFile(serveConfigPath);
  const agents = (serveConfig.agents ?? {}) as Record<
    string,
    { offerings?: Record<string, { dir: string; protocols?: ServeProtocol[] }> }
  >;
  const agentConfig = agents[agentId];
  if (!agentConfig?.offerings) return [];

  return Object.entries(agentConfig.offerings).map(([slug, entry]) => {
    const dir = resolve(rootDir, entry.dir);
    const offeringJsonPath = resolve(dir, "offering.json");
    return {
      slug,
      dir,
      protocols: entry.protocols ?? ["x402", "mpp", "acp"],
      offeringJson: existsSync(offeringJsonPath)
        ? readJsonFile(offeringJsonPath)
        : {},
    };
  });
}

function selectLocalOfferings(
  offerings: LocalOfferingConfig[],
  selector?: string,
): LocalOfferingConfig[] {
  if (!selector) return offerings;
  const normalized = selector.trim().toLowerCase();
  return offerings.filter((entry) => {
    const id =
      typeof entry.offeringJson.id === "string" ? entry.offeringJson.id : "";
    const name =
      typeof entry.offeringJson.name === "string"
        ? entry.offeringJson.name
        : "";
    return (
      entry.slug.toLowerCase() === normalized ||
      id.toLowerCase() === normalized ||
      name.toLowerCase() === normalized
    );
  });
}

function findRemoteOffering(
  local: LocalOfferingConfig,
  agent: Agent,
): AgentOffering | undefined {
  const localId =
    typeof local.offeringJson.id === "string"
      ? local.offeringJson.id
      : undefined;
  if (localId)
    return agent.offerings.find((offering) => offering.id === localId);

  const localName =
    typeof local.offeringJson.name === "string"
      ? local.offeringJson.name
      : undefined;
  if (!localName) return undefined;

  const matches = agent.offerings.filter(
    (offering) => offering.name === localName,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function materializeOffering(
  local: LocalOfferingConfig,
  remote: AgentOffering | undefined,
) {
  const localName =
    typeof local.offeringJson.name === "string"
      ? local.offeringJson.name
      : local.slug;
  const localDescription =
    typeof local.offeringJson.description === "string"
      ? local.offeringJson.description
      : "";
  const localPriceValue =
    typeof local.offeringJson.priceValue === "number"
      ? local.offeringJson.priceValue
      : Number(local.offeringJson.priceValue ?? 0);

  return {
    id:
      remote?.id ??
      (typeof local.offeringJson.id === "string"
        ? local.offeringJson.id
        : local.slug),
    slug: local.slug,
    name: remote?.name ?? localName,
    description: remote?.description ?? localDescription,
    priceType:
      remote?.priceType ??
      (typeof local.offeringJson.priceType === "string"
        ? local.offeringJson.priceType
        : "fixed"),
    priceValue: remote ? Number(remote.priceValue) : localPriceValue,
    slaMinutes:
      remote?.slaMinutes ??
      (typeof local.offeringJson.slaMinutes === "number"
        ? local.offeringJson.slaMinutes
        : Number(local.offeringJson.slaMinutes ?? 5)),
    requirements:
      remote?.requirements ??
      (local.offeringJson.requirements as Record<string, unknown> | string) ??
      {},
    deliverable:
      remote?.deliverable ??
      (local.offeringJson.deliverable as Record<string, unknown> | string) ??
      {},
  };
}

async function getOrCreateAgentToken(wallet: string): Promise<string> {
  const existing = getAgentToken(wallet);
  if (existing && !isExpiredJwt(existing)) return existing;

  const chainId = Number(process.env.ACP_CHAIN_ID || "84532");
  return AuthApi.fetchAndStoreAgentToken(wallet, chainId, getApiUrl());
}

function isExpiredJwt(token: string, skewSeconds = 60): boolean {
  const [, payload] = token.split(".");
  if (!payload) return true;

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { exp?: unknown };
    if (typeof decoded.exp !== "number") return true;
    return decoded.exp <= Math.floor(Date.now() / 1000) + skewSeconds;
  } catch {
    return true;
  }
}

function getDefaultPort(input: unknown): number {
  const port = Number(input ?? 3000);
  return Number.isFinite(port) && port > 0 ? port : 3000;
}

function railwayServiceArgs(
  args: string[],
  opts: Pick<RailwayDeployOptions, "serviceName" | "environment">,
): string[] {
  const result = [...args, "--service", opts.serviceName];
  if (opts.environment) result.push("--environment", opts.environment);
  return result;
}

function railwayDeployArgs(
  args: string[],
  opts: Pick<RailwayDeployOptions, "serviceName" | "project" | "environment">,
): string[] {
  const result = railwayServiceArgs(args, opts);
  if (opts.project) result.push("--project", opts.project);
  return result;
}

function runRailway(
  args: string[],
  cwd: string,
  input?: string,
): { command: string; stdout: string; stderr: string } {
  const command = `railway ${args.join(" ")}`;
  const result = spawnSync("railway", args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    throw new Error(
      `Failed to run Railway CLI. Install and login with \`railway login\` first. ${result.error.message}`,
    );
  }

  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
    throw new Error(`${command} failed.\n${output}`);
  }

  return {
    command,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function deployRailway(opts: RailwayDeployOptions): {
  commands: string[];
  deploymentOutput: string;
} {
  const commands: string[] = [];
  const base = { ...opts, serviceName: opts.serviceName };
  const envVars = Object.entries(opts.variables)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`);

  if (opts.project) {
    const linkArgs = [
      "link",
      "--project",
      opts.project,
      "--service",
      opts.serviceName,
    ];
    if (opts.environment) linkArgs.push("--environment", opts.environment);
    const result = runRailway(linkArgs, opts.bundleDir);
    commands.push(result.command);
  }

  if (envVars.length > 0) {
    const result = runRailway(
      railwayServiceArgs(
        ["variable", "set", "--skip-deploys", ...envVars],
        base,
      ),
      opts.bundleDir,
    );
    commands.push(result.command);
  }

  const tokenResult = runRailway(
    railwayServiceArgs(
      ["variable", "set", "--skip-deploys", "--stdin", "ACP_AGENT_TOKEN"],
      base,
    ),
    opts.bundleDir,
    opts.agentToken,
  );
  commands.push(tokenResult.command);

  const deployResult = runRailway(
    railwayDeployArgs(["up", ".", "--detach", "--path-as-root"], base),
    opts.bundleDir,
  );
  commands.push(deployResult.command);

  return {
    commands,
    deploymentOutput: [deployResult.stdout, deployResult.stderr]
      .filter(Boolean)
      .join("\n")
      .trim(),
  };
}

function copyRuntimeBundle(
  rootDir: string,
  bundleDir: string,
  active: { wallet: string; agentId: string },
  agentName: string,
  local: LocalOfferingConfig,
  apiUrl: string,
  serviceName: string,
): Record<string, string> {
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });

  for (const relativePath of [
    "bin",
    "src",
    "serve",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]) {
    const source = resolve(process.cwd(), relativePath);
    if (existsSync(source)) {
      cpSync(source, resolve(bundleDir, relativePath), { recursive: true });
    }
  }

  const agentSlug = slugify(agentName);
  const destination = resolve(
    bundleDir,
    "agents",
    agentSlug,
    "offerings",
    local.slug,
  );
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(local.dir, destination, { recursive: true });

  writeFileSync(
    resolve(bundleDir, "serve.json"),
    JSON.stringify(
      {
        agents: {
          [active.agentId]: {
            name: agentName,
            offerings: {
              [local.slug]: {
                dir: `agents/${agentSlug}/offerings/${local.slug}`,
                protocols: local.protocols,
                registered: true,
              },
            },
          },
        },
        evaluator: "self",
        port: 3000,
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    resolve(bundleDir, ".env.example"),
    [
      `ACP_ACTIVE_WALLET=${active.wallet}`,
      `ACP_AGENT_ID=${active.agentId}`,
      `ACP_API_URL=${apiUrl}`,
      `ACP_SERVE_OFFERING=${local.slug}`,
      "ACP_AGENT_TOKEN=",
      "IS_TESTNET=",
      "",
    ].join("\n"),
  );

  writeFileSync(
    resolve(bundleDir, "Dockerfile"),
    [
      "FROM node:20-alpine",
      "WORKDIR /app",
      "COPY package*.json ./",
      "RUN npm ci",
      "COPY . .",
      'CMD ["sh", "-c", "npx tsx bin/acp.ts serve start --dir . --offering ${ACP_SERVE_OFFERING} --port ${PORT:-3000}"]',
      "",
    ].join("\n"),
  );

  return {
    x402: serviceJobEndpoint(apiUrl, active.wallet, local.slug, "x402"),
    mpp: serviceJobEndpoint(apiUrl, active.wallet, local.slug, "mpp"),
    health: `https://${serviceName}.example/health`,
  };
}

export function registerServeCommands(program: Command): void {
  const serve = program
    .command("serve")
    .description("Scaffold and run ACP service-job provider runtimes");

  serve
    .command("init")
    .description("Scaffold a local offering runtime")
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
          offeringSlug,
        );

        if (existsSync(resolve(offeringDir, "handler.ts"))) {
          throw new Error(`Handler already exists at ${offeringDir}.`);
        }

        mkdirSync(offeringDir, { recursive: true });
        const scaffoldDir = resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../../serve/scaffold",
        );
        const offeringTemplate = readFileSync(
          resolve(scaffoldDir, "offering.json.template"),
          "utf8",
        );

        writeFileSync(
          resolve(offeringDir, "offering.json"),
          offeringTemplate.replace("{{NAME}}", opts.name),
        );
        writeFileSync(
          resolve(offeringDir, "handler.ts"),
          readFileSync(resolve(scaffoldDir, "handler.ts.template"), "utf8"),
        );
        writeFileSync(
          resolve(offeringDir, "budget.ts"),
          readFileSync(resolve(scaffoldDir, "budget.ts.template"), "utf8"),
        );

        const serveConfigPath = getServeConfigPath(rootDir);
        const serveConfig = existsSync(serveConfigPath)
          ? readJsonFile(serveConfigPath)
          : { agents: {}, evaluator: "self", port: 3000 };
        const agents = (serveConfig.agents ?? {}) as Record<string, any>;
        const agentConfig = (agents[active.agentId] ?? {
          name: agent.name,
          offerings: {},
        }) as Record<string, any>;
        agentConfig.offerings ??= {};
        agentConfig.offerings[offeringSlug] = {
          dir: `agents/${agentSlug}/offerings/${offeringSlug}`,
          protocols: ["x402", "mpp", "acp"],
          registered: false,
        };
        agents[active.agentId] = agentConfig;
        serveConfig.agents = agents;
        writeFileSync(
          serveConfigPath,
          JSON.stringify(serveConfig, null, 2) + "\n",
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
    .description("Start the provider runtime for a single offering")
    .option("--dir <path>", "Project root directory", ".")
    .option("--offering <selector>", "Offering slug, ID, or name")
    .option("--port <number>", "Local health-check port")
    .option("--settle-8183", "Reserved for future ERC-8183 settlement")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const active = requireActiveAgent(json);
        if (!active) return;

        const rootDir = resolve(opts.dir);
        const selected = selectLocalOfferings(
          loadLocalOfferings(rootDir, active.agentId),
          opts.offering,
        );
        if (selected.length === 0)
          throw new Error("No matching offerings found.");
        if (selected.length > 1) {
          throw new Error("Multiple offerings matched. Use --offering.");
        }

        const agentName = getLocalAgentName(rootDir, active.agentId);
        let agent: Agent | undefined;
        try {
          const { agentApi } = await getClient();
          agent = await agentApi.getById(active.agentId);
        } catch {
          agent = undefined;
        }
        const local = selected[0];
        const offering = materializeOffering(
          local,
          agent ? findRemoteOffering(local, agent) : undefined,
        );
        const { startOfferingServer } =
          await import("../../serve/server/index");

        await startOfferingServer({
          dir: local.dir,
          port: opts.port ? Number(opts.port) : getDefaultPort(undefined),
          agentSlug: slugify(agent?.name ?? agentName),
          providerWallet: active.wallet,
          offering,
          protocols: local.protocols,
          settle8183: opts.settle8183 === true,
          apiUrl: getApiUrl(),
          agentToken: await getOrCreateAgentToken(active.wallet),
        });
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  serve
    .command("endpoints")
    .description("Show canonical BE x402/MPP endpoints")
    .option("--dir <path>", "Project root directory", ".")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const active = requireActiveAgent(json);
        if (!active) return;

        const apiUrl = getApiUrl();
        const payload: Record<string, Record<string, string>> = {};
        for (const offering of loadLocalOfferings(
          resolve(opts.dir),
          active.agentId,
        )) {
          payload[offering.slug] = {};
          if (offering.protocols.includes("x402")) {
            payload[offering.slug].x402 = serviceJobEndpoint(
              apiUrl,
              active.wallet,
              offering.slug,
              "x402",
            );
          }
          if (offering.protocols.includes("mpp")) {
            payload[offering.slug].mpp = serviceJobEndpoint(
              apiUrl,
              active.wallet,
              offering.slug,
              "mpp",
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
    .description("Build a deployable provider runtime bundle")
    .option("--dir <path>", "Project root directory", ".")
    .option("--offering <selector>", "Offering slug, ID, or name")
    .option("--provider <name>", "Deployment provider label", "railway")
    .option("--service <name>", "Service name override")
    .option(
      "--execute",
      "Run the provider deployment after building the bundle",
    )
    .option("--railway-project <id>", "Railway project ID for --execute")
    .option("--railway-environment <name>", "Railway environment for --execute")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const active = requireActiveAgent(json);
        if (!active) return;

        const rootDir = resolve(opts.dir);
        const serveConfig = readJsonFile(getServeConfigPath(rootDir));
        const selected = selectLocalOfferings(
          loadLocalOfferings(rootDir, active.agentId),
          opts.offering,
        );
        if (selected.length === 0)
          throw new Error("No matching offerings found.");
        if (selected.length > 1) {
          throw new Error("Multiple offerings matched. Use --offering.");
        }

        const agentConfig = (serveConfig.agents as any)?.[active.agentId];
        const agentName = agentConfig?.name ?? "agent";
        const local = selected[0];
        const serviceName =
          opts.service ?? `${slugify(agentName)}-${local.slug}`;
        const provider = String(opts.provider ?? "railway");
        const bundleDir = resolve(
          rootDir,
          ".acp",
          "serve",
          "deploy",
          provider,
          serviceName,
        );
        const endpoints = copyRuntimeBundle(
          rootDir,
          bundleDir,
          active,
          agentName,
          local,
          getApiUrl(),
          serviceName,
        );

        if (opts.execute && provider !== "railway") {
          throw new Error(
            `Provider ${provider} does not support --execute yet.`,
          );
        }

        let execution:
          | {
              commands: string[];
              deploymentOutput: string;
            }
          | undefined;
        if (opts.execute) {
          execution = deployRailway({
            bundleDir,
            serviceName,
            project: opts.railwayProject,
            environment: opts.railwayEnvironment,
            agentToken: await getOrCreateAgentToken(active.wallet),
            variables: {
              ACP_ACTIVE_WALLET: active.wallet,
              ACP_AGENT_ID: active.agentId,
              ACP_API_URL: getApiUrl(),
              ACP_PUBLIC_KEY: getPublicKey(active.wallet),
              ACP_SERVE_OFFERING: local.slug,
              ACP_WALLET_ID: getWalletId(active.wallet),
              ACP_CHAIN_ID: process.env.ACP_CHAIN_ID,
              IS_TESTNET: process.env.IS_TESTNET,
              MPP_SECRET_KEY:
                process.env.MPP_SECRET_KEY || randomBytes(32).toString("hex"),
            },
          });
        }

        outputResult(json, {
          provider,
          serviceName,
          bundleDir,
          executed: Boolean(execution),
          endpoints,
          execution,
          nextSteps: [
            execution
              ? `Railway deployment started for service ${serviceName}.`
              : `Run with --execute to deploy to Railway, or deploy ${bundleDir} with Docker/provider CLI.`,
            `The public x402/MPP endpoints are the BE endpoints above; the deployment only needs outbound access to BE.`,
          ],
        });
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  serve
    .command("stop")
    .description("Stop a locally running offering runtime")
    .option("--dir <path>", "Project root directory", ".")
    .option("--offering <selector>", "Offering slug, ID, or name")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const active = requireActiveAgent(json);
        if (!active) return;
        const { getPidFilePath } = await import("../../serve/server/index");
        const rootDir = resolve(opts.dir);
        let agent: Agent | undefined;
        try {
          const { agentApi } = await getClient();
          agent = await agentApi.getById(active.agentId);
        } catch {
          agent = undefined;
        }
        let stopped = 0;
        for (const local of selectLocalOfferings(
          loadLocalOfferings(rootDir, active.agentId),
          opts.offering,
        )) {
          const offering = materializeOffering(
            local,
            agent ? findRemoteOffering(local, agent) : undefined,
          );
          const legacyOfferingId =
            typeof local.offeringJson.id === "string"
              ? local.offeringJson.id
              : local.slug;
          const pidFiles = [
            getPidFilePath(offering.id),
            ...(offering.id === legacyOfferingId
              ? []
              : [getPidFilePath(legacyOfferingId)]),
          ];
          for (const pidFile of pidFiles) {
            if (!existsSync(pidFile)) continue;
            const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
            try {
              process.kill(pid, "SIGTERM");
              stopped += 1;
            } catch {}
            break;
          }
        }
        outputResult(json, { success: true, stopped });
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  serve
    .command("logs")
    .description("Read recent serve logs")
    .option("--offering <slug>", "Offering slug or ID")
    .option("--follow", "Tail logs in real time")
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
        const logs = files.flatMap((file) =>
          readFileSync(file, "utf8").trim().split("\n").filter(Boolean),
        );
        outputResult(json, { logs: logs.slice(-50) });

        if (opts.follow && files.length > 0 && !json) {
          const offsets = new Map(
            files.map((file) => [file, statSync(file).size]),
          );
          for (const file of files) {
            watchFile(file, { interval: 1000 }, () => {
              const currentSize = statSync(file).size;
              const previousSize = offsets.get(file) ?? 0;
              if (currentSize <= previousSize) return;
              const chunk = readFileSync(file).subarray(
                previousSize,
                currentSize,
              );
              process.stdout.write(chunk.toString("utf8"));
              offsets.set(file, currentSize);
            });
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });
}
