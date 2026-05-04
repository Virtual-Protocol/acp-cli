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
}

interface JobRegistryEntry {
  legacy: boolean;
  chainId: number;
}

interface Config {
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

export async function getToken(): Promise<string | undefined> {
  return (
    getEnv("ACP_ACCESS_TOKEN") ??
    ((await getPassword(AUTH_KEYCHAIN_SERVICE, "access-token")) ?? undefined)
  );
}

export async function getRefreshToken(): Promise<string | undefined> {
  return (
    getEnv("ACP_REFRESH_TOKEN") ??
    ((await getPassword(AUTH_KEYCHAIN_SERVICE, "refresh-token")) ?? undefined)
  );
}

export async function setTokens(
  accessToken: string,
  refreshToken: string
): Promise<void> {
  await setPassword(AUTH_KEYCHAIN_SERVICE, "access-token", accessToken);
  await setPassword(AUTH_KEYCHAIN_SERVICE, "refresh-token", refreshToken);
}

export function getAgentToken(walletAddress: string): string | undefined {
  return getEnv("ACP_AGENT_TOKEN") ?? loadConfig().agents?.[walletAddress]?.token;
}

export function setAgentToken(walletAddress: string, token: string): void {
  const config = loadConfig();
  config.agents ??= {};
  config.agents[walletAddress] ??= { publicKey: "" };
  config.agents[walletAddress].token = token;
  saveConfig(config);
}

export function getWalletId(walletAddress: string): string | undefined {
  return getEnv("ACP_WALLET_ID") ?? loadConfig().agents?.[walletAddress]?.walletId;
}

export function setWalletId(walletAddress: string, walletId: string): void {
  const config = loadConfig();
  config.agents ??= {};
  config.agents[walletAddress] ??= { publicKey: "" };
  config.agents[walletAddress].walletId = walletId;
  saveConfig(config);
}

export function getPublicKey(agentAddress: string): string | undefined {
  return getEnv("ACP_PUBLIC_KEY") ?? loadConfig().agents?.[agentAddress]?.publicKey;
}

export function setPublicKey(agentAddress: string, publicKey: string): void {
  const config = loadConfig();
  config.agents ??= {};
  config.agents[agentAddress] ??= { publicKey: "" };
  config.agents[agentAddress].publicKey = publicKey;
  saveConfig(config);
}

export function getAgentId(walletAddress: string): string | undefined {
  return getEnv("ACP_AGENT_ID") ?? loadConfig().agents?.[walletAddress]?.id;
}

export function setAgentId(walletAddress: string, id: string): void {
  const config = loadConfig();
  config.agents ??= {};
  config.agents[walletAddress] ??= { publicKey: "" };
  config.agents[walletAddress].id = id;
  saveConfig(config);
}

export function getActiveWallet(): string | undefined {
  return getEnv("ACP_ACTIVE_WALLET") ?? loadConfig().activeWallet;
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
