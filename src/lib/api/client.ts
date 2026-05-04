import {
  getAgentToken,
  getRefreshToken,
  getToken,
  isTokenExpired,
  setTokens,
} from "../config";
import { CliError } from "../errors";
import { AuthApi } from "./auth";
import { AgentApi } from "./agent";
import {
  ACP_SERVER_URL,
  ACP_TESTNET_SERVER_URL,
} from "@virtuals-protocol/acp-node-v2";

export class ApiClient {
  constructor(private baseUrl: string, private token?: string) {}

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetch(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async delete<T>(path: string): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetch(url.toString(), {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }
}

export function getApiUrl(): string {
  const isTestnet = process.env.IS_TESTNET === "true";
  return (
    process.env.ACP_API_URL ??
    (isTestnet ? ACP_TESTNET_SERVER_URL : ACP_SERVER_URL)
  );
}

async function resolveToken(
  walletAddress: string | undefined,
  apiUrl: string
): Promise<string> {
  if (walletAddress) {
    let token = getAgentToken(walletAddress);
    if (!token || isTokenExpired(token)) {
      const chainId = Number(process.env.ACP_CHAIN_ID || "84532");
      token = await AuthApi.fetchAndStoreToken(walletAddress, chainId, apiUrl);
    }
    return token;
  }
  const token = await getToken();
  if (!token) {
    throw new CliError(
      "Not authenticated.",
      "NOT_AUTHENTICATED",
      "Run `acp configure` to authenticate."
    );
  }

  if (!isTokenExpired(token)) {
    return token;
  }

  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    throw new CliError(
      "Session expired.",
      "NOT_AUTHENTICATED",
      "Run `acp configure` to re-authenticate."
    );
  }

  const authApi = new AuthApi(new ApiClient(apiUrl));
  const result = await authApi.refreshCliToken(refreshToken);
  if (!result) {
    throw new CliError(
      "Session expired.",
      "NOT_AUTHENTICATED",
      "Run `acp configure` to re-authenticate."
    );
  }

  await setTokens(result.token, result.refreshToken);
  return result.token;
}

export async function getClient(
  walletAddress?: string,
  unauthenticated = false
): Promise<{
  agentApi: AgentApi;
  authApi: AuthApi;
}> {
  const apiUrl = getApiUrl();
  const token = unauthenticated
    ? undefined
    : await resolveToken(walletAddress, apiUrl);
  const httpClient = new ApiClient(apiUrl, token);
  return {
    agentApi: new AgentApi(httpClient),
    authApi: new AuthApi(httpClient),
  };
}

export async function getAgentApi(walletAddress?: string): Promise<AgentApi> {
  return (await getClient(walletAddress)).agentApi;
}
