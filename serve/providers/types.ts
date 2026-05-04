export type DeployProviderName = "railway" | "cloudflare";

export interface DeployTarget {
  rootDir: string;
  serviceName: string;
  providerWallet: string;
  agentId: string;
  agentName: string;
  apiUrl: string;
  offering: {
    id: string;
    slug: string;
    name: string;
    description: string;
    priceType: string;
    priceValue: number;
    slaMinutes: number;
    requirements: Record<string, unknown> | string;
    deliverable: Record<string, unknown> | string;
  };
  entryDir: string;
  protocols: ("x402" | "mpp" | "acp")[];
  walletId: string;
  deploySigner: {
    publicKey: string;
    privateKey: string;
  };
}

export interface DeployResult {
  provider: DeployProviderName;
  bundleDir: string;
  serviceName: string;
  endpoints: Record<string, string>;
  executed: boolean;
  nextSteps: string[];
}

export interface DeployOptions {
  project?: string;
  environment?: string;
  service?: string;
  domain?: string;
  execute?: boolean;
}

export interface DeployProvider {
  readonly name: DeployProviderName;
  deploy(target: DeployTarget, options: DeployOptions): Promise<DeployResult>;
}
