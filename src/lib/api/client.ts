import {
  getCurrentOwnerWallet,
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

  async patch<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetch(url.toString(), {
      method: "PATCH",
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

async function resolveToken(apiUrl: string): Promise<string> {
  const ownerWallet = getCurrentOwnerWallet();
  const token = await getToken(ownerWallet);
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

  const refreshToken = await getRefreshToken(ownerWallet);
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

  await setTokens(result.token, result.refreshToken, ownerWallet);
  return result.token;
}

export async function getClient(unauthenticated?: boolean): Promise<{
  agentApi: AgentApi;
  authApi: AuthApi;
}> {
  const isTestnet = process.env.IS_TESTNET === "true";
  const apiUrl = isTestnet ? ACP_TESTNET_SERVER_URL : ACP_SERVER_URL;
  const token = unauthenticated ? undefined : await resolveToken(apiUrl);
  const httpClient = new ApiClient(apiUrl, token);
  return {
    agentApi: new AgentApi(httpClient),
    authApi: new AuthApi(httpClient),
  };
}
