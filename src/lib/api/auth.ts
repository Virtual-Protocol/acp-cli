import { ApiClient } from "./client";
import { createProviderAdapter } from "../agentFactory";
import { setAgentToken } from "../config";

interface CliUrlResponse {
  data: { url: string; requestId: string };
}

interface CliTokenResponse {
  data: { token: string; refreshToken: string; walletAddress: string };
}

interface AgentTokenResponse {
  data: { token: string };
}

interface RequestAgentToken {
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

  async pollCliToken(requestId: string): Promise<{
    token: string;
    refreshToken: string;
    walletAddress: string;
  } | null> {
    try {
      const res = await this.client.get<CliTokenResponse>("/auth/cli/token", {
        requestId,
      });
      if (!res.data.token) return null;
      return {
        token: res.data.token,
        refreshToken: res.data.refreshToken,
        walletAddress: res.data.walletAddress,
      };
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

  async getAgentToken(data: RequestAgentToken): Promise<string> {
    const res = await this.client.post<AgentTokenResponse>("/auth/agent", data);
    const token = res.data.token;
    setAgentToken(data.walletAddress, token);
    return token;
  }

  static async fetchAndStoreAgentToken(
    walletAddress: string,
    chainId: number,
    baseUrl: string
  ): Promise<string> {
    const message = `acp-auth:${Date.now()}`;
    const provider = await createProviderAdapter();
    const signature = await provider.signMessage(chainId, message);
    const authApi = new AuthApi(new ApiClient(baseUrl));
    return authApi.getAgentToken({
      walletAddress,
      signature,
      message,
      chainId,
    });
  }
}
