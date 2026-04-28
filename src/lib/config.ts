import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getPassword, setPassword } from "cross-keychain";

const AUTH_KEYCHAIN_SERVICE = "acp-auth";

const CONFIG_PATH = resolve(process.cwd(), "config.json");

interface AgentConfig {
  publicKey: string;
  token?: string;
  walletId?: string;
  id?: string;
  builderCode?: string;
}

interface JobRegistryEntry {
  legacy: boolean;
  chainId: number;
}

interface Config {
  ownerWallet?: string;
  activeWallet?: string;
  agents?: Record<string, AgentConfig>;
  jobRegistry?: Record<string, JobRegistryEntry>;
}

function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  } catch {
    return {};
  }
}

function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function getAgentToken(walletAddress: string): string | undefined {
  return (
    getEnv("ACP_AGENT_TOKEN") ??
    loadConfig().agents?.[walletAddress]?.token ??
    loadConfig().agents?.[walletAddress.toLowerCase()]?.token
  );
}

export function setAgentToken(walletAddress: string, token: string): void {
  const config = loadConfig();
  config.agents ??= {};
  config.agents[walletAddress] ??= { publicKey: "" };
  config.agents[walletAddress].token = token;
  saveConfig(config);
}

export async function getToken(
  walletAddress?: string
): Promise<string | undefined> {
  return (
    (await getPassword(
      AUTH_KEYCHAIN_SERVICE,
      `access-token${walletAddress ? `-${walletAddress.toLowerCase()}` : ""}`
    )) ?? undefined
  );
}

export async function getRefreshToken(
  walletAddress?: string
): Promise<string | undefined> {
  return (
    (await getPassword(
      AUTH_KEYCHAIN_SERVICE,
      `refresh-token${walletAddress ? `-${walletAddress.toLowerCase()}` : ""}`
    )) ?? undefined
  );
}

export async function setTokens(
  accessToken: string,
  refreshToken: string,
  walletAddress?: string
): Promise<void> {
  await setPassword(
    AUTH_KEYCHAIN_SERVICE,
    `access-token${walletAddress ? `-${walletAddress.toLowerCase()}` : ""}`,
    accessToken
  );
  await setPassword(
    AUTH_KEYCHAIN_SERVICE,
    `refresh-token${walletAddress ? `-${walletAddress.toLowerCase()}` : ""}`,
    refreshToken
  );
}

export function getWalletId(walletAddress: string): string | undefined {
  return loadConfig().agents?.[walletAddress]?.walletId;
}

export function setWalletId(walletAddress: string, walletId: string): void {
  const config = loadConfig();
  config.agents ??= {};
  config.agents[walletAddress] ??= { publicKey: "" };
  config.agents[walletAddress].walletId = walletId;
  saveConfig(config);
}

export function getPublicKey(agentAddress: string): string | undefined {
  return loadConfig().agents?.[agentAddress]?.publicKey;
}

export function setPublicKey(agentAddress: string, publicKey: string): void {
  const config = loadConfig();
  config.agents ??= {};
  config.agents[agentAddress] ??= { publicKey: "" };
  config.agents[agentAddress].publicKey = publicKey;
  saveConfig(config);
}

export function getAgentId(walletAddress: string): string | undefined {
  return loadConfig().agents?.[walletAddress]?.id;
}

export function setAgentId(walletAddress: string, id: string): void {
  const config = loadConfig();
  config.agents ??= {};
  config.agents[walletAddress] ??= { publicKey: "" };
  config.agents[walletAddress].id = id;
  saveConfig(config);
}

export function getActiveWallet(): string | undefined {
  return loadConfig().activeWallet;
}

export function getCurrentOwnerWallet(): string | undefined {
  return loadConfig().ownerWallet;
}

export function setCurrentOwnerWallet(walletAddress: string): void {
  const config = loadConfig();
  config.ownerWallet = walletAddress;
  saveConfig(config);
}

export function setActiveWallet(walletAddress: string): void {
  const config = loadConfig();
  config.activeWallet = walletAddress;
  saveConfig(config);
}

export function registerJob(
  jobId: string,
  legacy: boolean,
  chainId: number
): void {
  const config = loadConfig();
  config.jobRegistry ??= {};
  config.jobRegistry[jobId] = { legacy, chainId };
  saveConfig(config);
}

export function getJobRegistryEntry(
  jobId: string
): JobRegistryEntry | undefined {
  return loadConfig().jobRegistry?.[jobId];
}

export function isLegacyJob(jobId: string): boolean {
  return loadConfig().jobRegistry?.[jobId]?.legacy === true;
}

export function getLegacyJobChainId(jobId: string): number | undefined {
  const entry = loadConfig().jobRegistry?.[jobId];
  return entry?.legacy ? entry.chainId : undefined;
}

export function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString()
    );
    const bufferMs = 5 * 60 * 1000;
    return (
      typeof payload.exp === "number" &&
      payload.exp * 1000 < Date.now() + bufferMs
    );
  } catch {
    return true;
  }
}

export function setBuilderCode(
  walletAddress: string,
  builderCode: string
): void {
  const config = loadConfig();
  config.agents ??= {};
  config.agents[walletAddress] ??= { publicKey: "" };
  config.agents[walletAddress].builderCode = builderCode;
  saveConfig(config);
}

export function getBuilderCode(walletAddress: string): string | undefined {
  return loadConfig().agents?.[walletAddress]?.builderCode;
}
