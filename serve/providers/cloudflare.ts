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

export class CloudflareDeployProvider implements DeployProvider {
  readonly name = "cloudflare" as const;

  async deploy(
    target: DeployTarget,
    _options: DeployOptions
  ): Promise<DeployResult> {
    const bundleDir = getBundleRoot(target.rootDir, this.name, target.serviceName);
    copyRepoSubset(target.rootDir, bundleDir);
    copyOfferingDir(target, bundleDir);
    writeBundleServeJson(target, bundleDir);

    writeTextFile(
      resolve(bundleDir, "DEPLOYMENT_NOTES.md"),
      [
        "# Cloudflare deploy bundle",
        "",
        "This provider path is not fully implemented yet.",
        "Use Railway for end-to-end local testing.",
        "",
      ].join("\n")
    );

    return {
      provider: this.name,
      bundleDir,
      serviceName: target.serviceName,
      executed: false,
      endpoints: {},
      nextSteps: [
        "Cloudflare deployment is not implemented yet.",
      ],
    };
  }
}
