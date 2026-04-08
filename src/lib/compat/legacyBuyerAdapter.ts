import AcpClientDefault, {
  AcpJob,
  AcpMemo,
  AcpAgent as LegacyAgent,
  AcpContractConfig,
  baseSepoliaAcpConfigV2,
  baseAcpConfigV2,
  FareAmount,
  AcpJobPhases,
} from "@virtuals-protocol/acp-node";

// Handle CJS/ESM interop — default import may be double-wrapped
const AcpClient = (AcpClientDefault as any).default ?? AcpClientDefault;
import type { IEvmProviderAdapter } from "acp-node-v2";
import type { Address } from "viem";
import { LegacyContractBridge } from "./legacyContractBridge";

export type LegacyJobEventHandler = (job: AcpJob, memoToSign?: AcpMemo) => void;

/**
 * Adapter that lets acp-cli buyers create and manage jobs with legacy (openclaw-cli) sellers.
 * Wraps the old AcpClient internally using LegacyContractBridge for blockchain operations.
 */
export class LegacyBuyerAdapter {
  private acpClient: AcpClientDefault;
  readonly chainId: number;

  private constructor(acpClient: AcpClientDefault, chainId: number) {
    this.acpClient = acpClient;
    this.chainId = chainId;
  }

  /**
   * Create a LegacyBuyerAdapter using the same wallet provider that acp-cli already uses.
   * Pass onNewTask to receive real-time socket events from the old backend.
   */
  static async create(
    provider: IEvmProviderAdapter,
    chainId: number,
    options?: {
      onNewTask?: LegacyJobEventHandler;
    }
  ): Promise<LegacyBuyerAdapter> {
    const walletAddress = (await provider.getAddress()) as Address;

    const config = resolveLegacyConfig(chainId);

    const bridge = new LegacyContractBridge(walletAddress, config, provider);

    const connectSocket = !!options?.onNewTask;

    const acpClient = new AcpClient({
      acpContractClient: bridge as any,
      onNewTask: options?.onNewTask,
      skipSocketConnection: !connectSocket,
    });

    return new LegacyBuyerAdapter(acpClient, config.chain.id);
  }

  /**
   * Create a job targeting a v1 seller.
   * Returns the on-chain job ID.
   */
  async createJob(params: {
    providerAddress: string;
    requirement: string | Record<string, unknown>;
    amount: number;
    evaluatorAddress?: string;
    expiredAt?: Date;
    offeringName?: string;
    chainId: number;
  }): Promise<number> {
    const config = resolveLegacyConfig(params.chainId);
    const fareAmount = new FareAmount(params.amount, config.baseFare);

    // V1 sellers expect the first memo content to be JSON with shape:
    //   { name: "<offering name>", requirement: { ... } }
    // See openclaw-acp/src/seller/runtime/seller.ts resolveOfferingName/resolveServiceRequirements
    const serviceRequirement: Record<string, unknown> = {
      name: params.offeringName ?? "",
      requirement:
        typeof params.requirement === "string"
          ? params.requirement
          : params.requirement,
    };

    const jobId = await this.acpClient.initiateJob(
      params.providerAddress as Address,
      serviceRequirement,
      fareAmount,
      (params.evaluatorAddress as Address) || undefined,
      params.expiredAt || new Date(Date.now() + 1000 * 60 * 60 * 24), // 24h default
      params.offeringName
    );

    return jobId;
  }

  /**
   * Fund a v1 job by signing the seller's requirement memo.
   * Finds the pending memo and calls payAndAcceptRequirement.
   */
  async fundJob(jobId: number, reason?: string): Promise<void> {
    const job = await this.acpClient.getJobById(jobId);
    if (!job) {
      throw new Error(`V1 job ${jobId} not found`);
    }

    await job.payAndAcceptRequirement(reason);
  }

  /**
   * Complete (approve) a v1 job — releases escrowed funds to seller.
   */
  async completeJob(jobId: number, reason?: string): Promise<void> {
    const job = await this.acpClient.getJobById(jobId);
    if (!job) {
      throw new Error(`V1 job ${jobId} not found`);
    }

    await job.evaluate(true, reason);
  }

  /**
   * Reject a v1 job — returns escrowed funds to buyer.
   */
  async rejectJob(jobId: number, reason?: string): Promise<void> {
    const job = await this.acpClient.getJobById(jobId);
    if (!job) {
      throw new Error(`V1 job ${jobId} not found`);
    }

    await job.evaluate(false, reason);
  }

  /**
   * Get a v1 job by ID.
   */
  async getJob(jobId: number): Promise<AcpJob | null> {
    return this.acpClient.getJobById(jobId);
  }

  /**
   * Get all active legacy jobs for this wallet.
   */
  async getActiveJobs(): Promise<AcpJob[]> {
    return this.acpClient.getActiveJobs();
  }

  /**
   * Browse legacy agents by keyword using the old backend's search.
   */
  async browse(
    keyword: string,
    options?: { topK?: number; cluster?: string; onlineStatus?: string }
  ): Promise<LegacyAgent[]> {
    return this.acpClient.browseAgents(keyword, {
      topK: options?.topK,
      cluster: options?.cluster,
      onlineStatus: options?.onlineStatus as any,
    });
  }

  /**
   * Get a legacy agent by wallet address.
   */
  async getAgent(walletAddress: string): Promise<LegacyAgent | null> {
    return this.acpClient.getAgent(walletAddress as Address);
  }

  /**
   * Map a v1 job phase to v2-style status string.
   */
  static phaseToStatus(phase: AcpJobPhases): string {
    switch (phase) {
      case AcpJobPhases.REQUEST:
        return "open";
      case AcpJobPhases.NEGOTIATION:
        return "budget_set";
      case AcpJobPhases.TRANSACTION:
        return "funded";
      case AcpJobPhases.EVALUATION:
        return "submitted";
      case AcpJobPhases.COMPLETED:
        return "completed";
      case AcpJobPhases.REJECTED:
        return "rejected";
      case AcpJobPhases.EXPIRED:
        return "expired";
      default:
        return "unknown";
    }
  }
}

/**
 * Resolve the old SDK config for a given chain ID.
 * Defaults to Base Sepolia testnet.
 */
function resolveLegacyConfig(chainId: number): AcpContractConfig {
  if (chainId === 8453) {
    return baseAcpConfigV2;
  } else if (chainId === 84532) {
    return baseSepoliaAcpConfigV2;
  }

  throw new Error(`Unsupported chain ID: ${chainId}`);
}
