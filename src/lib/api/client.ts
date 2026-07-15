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
import { PolicyApi } from "./policy";
import {
  ACP_SERVER_URL,
  ACP_TESTNET_SERVER_URL,
} from "@virtuals-protocol/acp-node-v2";

// Hard ceiling on any single API request. Without it, a stalled connection
// makes `fetch` hang forever — which froze the trade loop indefinitely mid-trade
// (a /trade/next call never returned, so the loop neither advanced nor errored).
// Generous enough for slow legitimate calls (e.g. a LiFi quote inside
// /trade/next) but bounded, so a hung request fails fast and is recoverable.
const REQUEST_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new CliError(
        `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s (no response from the server).`,
        "TIMEOUT",
        "Re-run the command — the request stalled rather than failing, and is safe to retry.",
      );
    }
    throw err;
  }
}

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
    const res = await fetchWithTimeout(url.toString(), { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetchWithTimeout(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetchWithTimeout(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetchWithTimeout(url.toString(), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async delete<T>(path: string): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetchWithTimeout(url.toString(), {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  // Raw GET for endpoints that return binary (e.g. attachment download).
  // Returns the Response so the caller can stream the body and read
  // `content-type` / `content-disposition` headers from upstream.
  async getRaw(
    path: string,
    params?: Record<string, string>,
  ): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const res = await fetchWithTimeout(url.toString(), { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res;
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

/**
 * Force a token refresh via the stored refresh token, regardless of local expiry.
 * For mid-trade 401s: a long-running trade can outlive its access token (the
 * loop captures it once), and the local expiry check can disagree with the
 * server, so re-resolving isn't enough — mint a fresh one unconditionally and
 * persist it. Returns the new access token.
 */
export async function forceTokenRefresh(apiUrl: string): Promise<string> {
  const ownerWallet = getCurrentOwnerWallet();
  const refreshToken = await getRefreshToken(ownerWallet);
  if (!refreshToken) {
    throw new CliError(
      "Session expired.",
      "NOT_AUTHENTICATED",
      "Run `acp configure` to re-authenticate.",
    );
  }
  const authApi = new AuthApi(new ApiClient(apiUrl));
  const result = await authApi.refreshCliToken(refreshToken);
  if (!result) {
    throw new CliError(
      "Session expired.",
      "NOT_AUTHENTICATED",
      "Run `acp configure` to re-authenticate.",
    );
  }
  await setTokens(result.token, result.refreshToken, ownerWallet);
  return result.token;
}

export async function getClient(unauthenticated?: boolean): Promise<{
  agentApi: AgentApi;
  authApi: AuthApi;
  policyApi: PolicyApi;
}> {
  const isTestnet = process.env.IS_TESTNET === "true";
  const apiUrl = isTestnet ? ACP_TESTNET_SERVER_URL : ACP_SERVER_URL;
  const token = unauthenticated ? undefined : await resolveToken(apiUrl);
  const httpClient = new ApiClient(apiUrl, token);
  return {
    agentApi: new AgentApi(httpClient),
    authApi: new AuthApi(httpClient),
    policyApi: new PolicyApi(httpClient),
  };
}

export async function getAgentApi(): Promise<AgentApi> {
  return (await getClient()).agentApi;
}

/**
 * Resolve the ACP API base URL + a valid bearer token for direct calls that
 * aren't covered by AgentApi/AuthApi (e.g. the `/trade/*` proxy). Reuses the
 * same testnet switch and token-refresh logic as getClient().
 */
export async function getApiContext(): Promise<{ apiUrl: string; token: string }> {
  const isTestnet = process.env.IS_TESTNET === "true";
  const realUrl = isTestnet ? ACP_TESTNET_SERVER_URL : ACP_SERVER_URL;
  // Resolve/refresh the bearer against the REAL ACP server so auth always works.
  const token = await resolveToken(realUrl);
  // LOCAL TEST ONLY: route /trade/* to a local proxy shim when set, leaving
  // token resolution untouched. Unset in normal use → real ACP backend.
  const apiUrl = process.env.ACP_TRADE_BASE_URL?.trim() || realUrl;
  return { apiUrl, token };
}
