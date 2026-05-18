import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

const IS_TESTNET = process.env.IS_TESTNET === "true";

const CONFIG_DIR = process.env.ACP_CONFIG_DIR
  ? resolve(process.env.ACP_CONFIG_DIR)
  : resolve(homedir(), ".config", "acp");
const PHONE_FILENAME = IS_TESTNET ? "phone-testnet.json" : "phone.json";
const PHONE_PATH = resolve(CONFIG_DIR, PHONE_FILENAME);

export interface PhoneMapping {
  agentphoneAgentId: string;
  voiceMode: "webhook" | "hosted";
  webhookUrl?: string;
  createdAt: string;
}

interface PhoneStore {
  agents?: Record<string, PhoneMapping>;
}

function load(): PhoneStore {
  if (!existsSync(PHONE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(PHONE_PATH, "utf8")) as PhoneStore;
  } catch {
    return {};
  }
}

function save(store: PhoneStore): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PHONE_PATH, JSON.stringify(store, null, 2) + "\n");
}

export function getPhoneMapping(acpAgentId: string): PhoneMapping | null {
  return load().agents?.[acpAgentId] ?? null;
}

export function setPhoneMapping(
  acpAgentId: string,
  mapping: PhoneMapping
): void {
  const store = load();
  store.agents ??= {};
  store.agents[acpAgentId] = mapping;
  save(store);
}

export function clearPhoneMapping(acpAgentId: string): void {
  const store = load();
  if (!store.agents?.[acpAgentId]) return;
  delete store.agents[acpAgentId];
  save(store);
}
