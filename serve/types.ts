/**
 * ACP Serve — Type definitions
 *
 * These types define the contract between the developer's handler code
 * and the ACP Serve runtime. The developer implements Handler (required)
 * and optionally BudgetHandler (for ACP native jobs).
 */

/** Input passed to all handler hooks */
export interface HandlerInput {
  /** Client's requirements data (validated against offering schema) */
  requirements: Record<string, unknown> | string;
  /** Offering metadata */
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
  /** The 8183 job ID (set after job creation) */
  jobId?: string;
  /** Client info */
  client: {
    address: string;
  };
  /** Which protocol the request came through */
  protocol: "x402" | "mpp" | "acp";
}

/** Output from the handler — the deliverable */
export interface HandlerOutput {
  /** The deliverable content (URL, text, JSON string, etc.) */
  deliverable: string;
}

/** Output from the budget handler — service fee + optional fund request */
export interface BudgetOutput {
  /** USDC service fee to charge */
  amount: number;
  /** Optional: request working capital from the client */
  fundRequest?: {
    /** USDC amount of working capital needed */
    transferAmount: number;
    /** Address to receive the working capital */
    destination: string;
  };
}

/**
 * The main handler function — REQUIRED.
 * Takes requirements, does the work, returns deliverable.
 * Called for all protocols (x402, MPP, ACP native) on job.funded.
 */
export type Handler = (input: HandlerInput) => Promise<HandlerOutput>;

/**
 * Budget handler — OPTIONAL (ACP native only).
 * Called on job.created to propose a service fee and optionally
 * request working capital. If not provided, the offering's fixed
 * price is used with no fund request.
 *
 * x402/MPP use the offering's fixed price automatically.
 */
export type BudgetHandler = (input: HandlerInput) => Promise<BudgetOutput>;

/** Configuration file (serve.json) */
export interface ServeConfig {
  offeringId: string;
  protocols: ("x402" | "mpp" | "acp")[];
  evaluator?: string;
  port?: number;
}

/** Registry entry for a deployed offering */
export interface DeployedOffering {
  offeringId: string;
  agentSlug: string;
  providerWallet: string;
  offering: HandlerInput["offering"];
  hasBudgetHandler: boolean;
  protocols: ("x402" | "mpp" | "acp")[];
  evaluator: string;
  /** When true, x402/MPP payments are settled on-chain via ERC-8183.
   *  When false (default), x402/MPP payments settle directly in the
   *  provider runtime before the handler runs. */
  settle8183: boolean;
}
