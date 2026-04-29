export type ServeProtocol = "x402" | "mpp" | "acp";

export interface HandlerInput {
  requirements: Record<string, unknown> | string;
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
  jobId?: string;
  client: {
    address: string;
  };
  protocol: ServeProtocol;
}

export interface HandlerOutput {
  deliverable: unknown;
}

export interface BudgetOutput {
  amount: number;
  fundRequest?: {
    transferAmount: number;
    destination: string;
  };
}

export type Handler = (input: HandlerInput) => Promise<HandlerOutput>;
export type BudgetHandler = (input: HandlerInput) => Promise<BudgetOutput>;

export interface DeployedOffering {
  offeringId: string;
  agentSlug: string;
  providerWallet: string;
  offering: HandlerInput["offering"];
  hasBudgetHandler: boolean;
  protocols: ServeProtocol[];
  evaluator: string;
  settle8183: boolean;
}
