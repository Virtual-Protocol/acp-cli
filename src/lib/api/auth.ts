import { ApiClient } from "./client";

interface CliUrlResponse {
  data: { url: string; requestId: string };
}

interface CliTokenResponse {
  data: { token: string; refreshToken: string; walletAddress: string };
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
}
