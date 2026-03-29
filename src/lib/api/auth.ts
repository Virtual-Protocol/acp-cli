import { EvmAcpClient } from "acp-node-v2";
import { createAgentFromConfig } from "../agentFactory";
import { setAgentToken } from "../config";
import { ApiClient } from "./client";

interface CliUrlResponse {
  data: { url: string; requestId: string };
}

interface CliTokenResponse {
  data: { token: string; refreshToken: string };
}

interface AuthTokenResponse {
  data: { token: string };
}

interface RequestAuthToken {
  walletAddress: string;
  signature: string;
  message: string;
  chainId: number;
}
export class AuthApi {
  constructor(private readonly client: ApiClient) {}

  async getCliUrl(): Promise<{ url: string; requestId: string }> {
    const res = await this.client.get<CliUrlResponse>("/auth/cli/url");
    return res.data;
  }

  async pollCliToken(
    requestId: string
  ): Promise<{ token: string; refreshToken: string } | null> {
    try {
      const res = await this.client.get<CliTokenResponse>("/auth/cli/token", {
        requestId,
      });
      if (!res.data.token) return null;
      return { token: res.data.token, refreshToken: res.data.refreshToken };
    } catch {
      return null;
    }
  }

  async refreshCliToken(
    refreshToken: string
  ): Promise<{ token: string; refreshToken: string } | null> {
    try {
      const res = await this.client.post<CliTokenResponse>(
        "/auth/cli/refresh",
        { refreshToken }
      );
      return { token: res.data.token, refreshToken: res.data.refreshToken };
    } catch {
      return null;
    }
  }

  async getAuthToken(data: RequestAuthToken): Promise<string> {
    try {
      const res = await this.client.post<AuthTokenResponse>("/auth/agent", {
        walletAddress: data.walletAddress,
        signature: data.signature,
        message: data.message,
        chainId: data.chainId,
      });
      const token = res.data.token;
      setAgentToken(data.walletAddress, token);
      return token;
    } catch (error) {
      throw new Error(
        `Failed to get auth token: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  static async fetchAndStoreToken(
    walletAddress: string,
    chainId: number,
    baseUrl: string
  ): Promise<string> {
    const message = `acp-auth:${Date.now()}`;

    const agent = await createAgentFromConfig();
    const acpClient = agent.getClient();
    if (!(acpClient instanceof EvmAcpClient)) {
      throw new Error("signMessage requires an EVM provider");
    }
    const signature = await acpClient.getProvider().signMessage(chainId, message);

    const authApi = new AuthApi(new ApiClient(baseUrl));
    return authApi.getAuthToken({ walletAddress, signature, message, chainId });
  }
}
