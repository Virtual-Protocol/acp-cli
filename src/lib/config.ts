import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const CONFIG_PATH = resolve(process.cwd(), "config.json");

interface AgentConfig {
  publicKey: string;
  token?: string;
  walletId?: string;
}

interface Config {
  acp_token?: string;
  acp_refresh_token?: string;
  activeWallet?: string;
  agents?: Record<string, AgentConfig>;
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

export function getToken(): string | undefined {
  return loadConfig().acp_token;
}

export function setupEnv(): void {
  const token = getToken();
  if (token) process.env.ACP_TOKEN = token;
}

export function setToken(token: string): void {
  const config = loadConfig();
  config.acp_token = token;
  saveConfig(config);
}

export function getRefreshToken(): string | undefined {
  return loadConfig().acp_refresh_token;
}

export function setTokens(accessToken: string, refreshToken: string): void {
  const config = loadConfig();
  config.acp_token = accessToken;
  config.acp_refresh_token = refreshToken;
  saveConfig(config);
}

export function getAgentToken(walletAddress: string): string | undefined {
  return loadConfig().agents?.[walletAddress]?.token;
}

export function setAgentToken(walletAddress: string, token: string): void {
  const config = loadConfig();
  config.agents ??= {};
  config.agents[walletAddress] ??= { publicKey: "" };
  config.agents[walletAddress].token = token;
  saveConfig(config);
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

export function getActiveWallet(): string | undefined {
  return loadConfig().activeWallet;
}

export function setActiveWallet(walletAddress: string): void {
  const config = loadConfig();
  config.activeWallet = walletAddress;
  saveConfig(config);
}

export function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString()
    );
    const bufferMs = 5 * 60 * 1000;
    return typeof payload.exp === "number" && payload.exp * 1000 < Date.now() + bufferMs;
  } catch {
    return true;
  }
}
