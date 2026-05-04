import { cpSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import type { DeployTarget } from "./types";

export function getBundleRoot(
  rootDir: string,
  provider: string,
  serviceName: string
): string {
  return resolve(rootDir, ".acp", "serve", "deploy", provider, serviceName);
}

export function ensureCleanDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function copyRepoSubset(rootDir: string, bundleDir: string): void {
  ensureCleanDir(bundleDir);
  for (const relativePath of [
    "bin",
    "serve",
    "src",
    "tsconfig.json",
    "package.json",
    "package-lock.json",
  ]) {
    const source = resolve(rootDir, relativePath);
    if (!existsSync(source)) continue;
    cpSync(source, resolve(bundleDir, relativePath), { recursive: true });
  }
}

export function writeBundleServeJson(
  target: DeployTarget,
  bundleDir: string
): void {
  const agentSlug = slugify(target.agentName);
  const offeringSlug = target.offering.slug;
  const payload = {
    agents: {
      [target.agentId]: {
        name: target.agentName,
        offerings: {
          [offeringSlug]: {
            dir: `agents/${agentSlug}/offerings/${offeringSlug}`,
            protocols: target.protocols,
            registered: true,
          },
        },
      },
    },
    evaluator: "self",
    port: 3000,
  };

  writeFileSync(
    resolve(bundleDir, "serve.json"),
    JSON.stringify(payload, null, 2) + "\n"
  );
}

export function copyOfferingDir(target: DeployTarget, bundleDir: string): void {
  const agentSlug = slugify(target.agentName);
  const destination = resolve(
    bundleDir,
    "agents",
    agentSlug,
    "offerings",
    target.offering.slug
  );
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(target.entryDir, destination, { recursive: true });
}

export function writeTextFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
