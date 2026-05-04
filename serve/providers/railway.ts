import { spawnSync } from "child_process";
import { resolve } from "path";
import type {
  DeployOptions,
  DeployProvider,
  DeployResult,
  DeployTarget,
} from "./types";
import {
  copyOfferingDir,
  copyRepoSubset,
  getBundleRoot,
  writeBundleServeJson,
  writeTextFile,
} from "./utils";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
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

/** Append project/environment flags. Not all railway subcommands support both. */
function appendScopedArgs(
  args: string[],
  options: DeployOptions,
  supports: { project?: boolean; environment?: boolean } = {}
): void {
  if (supports.project && options.project) args.push("-p", options.project);
  if (supports.environment && options.environment) args.push("-e", options.environment);
}

function runRailwayCommand(
  cwd: string,
  args: string[],
  tolerateFailure = false
): void {
  const result = spawnSync("railway", args, {
    cwd,
    stdio: "inherit",
  });
  if (result.status === 0 || tolerateFailure) return;
  throw new Error(`Railway command failed: railway ${args.join(" ")}`);
}

export class RailwayDeployProvider implements DeployProvider {
  readonly name = "railway" as const;

  async deploy(
    target: DeployTarget,
    options: DeployOptions
  ): Promise<DeployResult> {
    const bundleDir = getBundleRoot(target.rootDir, this.name, target.serviceName);
    copyRepoSubset(target.rootDir, bundleDir);
    copyOfferingDir(target, bundleDir);
    writeBundleServeJson(target, bundleDir);

    writeTextFile(
      resolve(bundleDir, "Dockerfile"),
      [
        "FROM node:20-alpine",
        "WORKDIR /app",
        "COPY package*.json ./",
        "RUN npm ci",
        "COPY . .",
        'CMD ["sh", "-c", "npx tsx bin/acp.ts serve start --dir . --offering ${ACP_SERVE_OFFERING} --port ${PORT:-3000}"]',
        "",
      ].join("\n")
    );

    const envPairs: [string, string][] = [
      ["ACP_ACTIVE_WALLET", target.providerWallet],
      ["ACP_AGENT_ID", target.agentId],
      ["ACP_API_URL", target.apiUrl],
      ["ACP_WALLET_ID", target.walletId],
      ["ACP_PUBLIC_KEY", target.deploySigner.publicKey],
      ["ACP_SIGNER_PRIVATE_KEY", target.deploySigner.privateKey],
      ["ACP_SERVE_OFFERING", target.offering.slug],
      ["IS_TESTNET", process.env.IS_TESTNET ?? ""],
      ["PARTNER_ID", process.env.PARTNER_ID ?? ""],
    ];

    const envLines = envPairs.map(([k, v]) => `${k}=${v}`);

    writeTextFile(resolve(bundleDir, ".env.example"), envLines.join("\n") + "\n");

    const serviceFlag = options.service ?? target.serviceName;
    const envFlag = options.environment
      ? ` -e ${shellEscape(options.environment)}`
      : "";
    const projectFlag = options.project
      ? ` -p ${shellEscape(options.project)}`
      : "";

    const nonEmptyEnvArgs = envPairs
      .filter(([, v]) => v !== "")
      .map(([k, v]) => `${shellEscape(`${k}=${v}`)}`);

    const nextSteps = [
      `railway add -s ${shellEscape(serviceFlag)}`,
      [
        "railway variable set",
        ...nonEmptyEnvArgs,
        `-s ${shellEscape(serviceFlag)}`,
        envFlag.trim(),
        "--skip-deploys",
      ]
        .filter(Boolean)
        .join(" "),
      [
        "railway up",
        shellEscape(bundleDir),
        "--path-as-root",
        `-s ${shellEscape(serviceFlag)}`,
        projectFlag.trim(),
        envFlag.trim(),
        "--detach",
      ]
        .filter(Boolean)
        .join(" "),
    ];

    if (options.execute) {
      const versionCheck = spawnSync("railway", ["--version"], {
        cwd: bundleDir,
        stdio: "ignore",
      });
      if (versionCheck.status !== 0) {
        throw new Error("Railway CLI not found.");
      }

      // Link the bundle dir to the project first (required for add/variable set)
      if (options.project) {
        const linkArgs = ["link", "-p", options.project];
        if (options.environment) linkArgs.push("-e", options.environment);
        runRailwayCommand(bundleDir, linkArgs);
      }

      const addArgs = ["add", "-s", serviceFlag];
      runRailwayCommand(bundleDir, addArgs, true);

      // `railway variable set` supports -s (service) and -e (environment)
      // Railway rejects empty values (e.g. IS_TESTNET=), so filter them out
      const variableArgs = [
        "variable",
        "set",
        ...envPairs.filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`),
        "-s",
        serviceFlag,
        "--skip-deploys",
      ];
      appendScopedArgs(variableArgs, options, { environment: true });
      runRailwayCommand(bundleDir, variableArgs);

      // `railway up` — project/environment already set via `railway link` above,
      // so we only pass -s (service). Adding -p without -e causes an error.
      const upArgs = [
        "up",
        bundleDir,
        "--path-as-root",
        "-s",
        serviceFlag,
        "--detach",
      ];
      runRailwayCommand(bundleDir, upArgs);

      // Generate a Railway domain, or attach a custom domain if provided
      if (options.domain) {
        runRailwayCommand(bundleDir, ["domain", options.domain, "-s", serviceFlag]);
      } else {
        runRailwayCommand(bundleDir, ["domain", "-s", serviceFlag], true);
      }
    }

    const baseUrl = options.domain
      ? `https://${options.domain}`
      : `https://${serviceFlag}-production.up.railway.app`;

    return {
      provider: this.name,
      bundleDir,
      serviceName: serviceFlag,
      executed: options.execute === true,
      endpoints: {
        x402: serviceJobEndpoint(
          target.apiUrl,
          target.providerWallet,
          target.offering.slug,
          "x402"
        ),
        mpp: serviceJobEndpoint(
          target.apiUrl,
          target.providerWallet,
          target.offering.slug,
          "mpp"
        ),
        health: `${baseUrl}/health`,
      },
      nextSteps,
    };
  }
}
