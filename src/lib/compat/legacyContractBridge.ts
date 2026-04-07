import {
  BaseAcpContractClient,
  AcpContractConfig,
} from "@virtuals-protocol/acp-node";
import type { IEvmProviderAdapter } from "acp-node-v2";
import type {
  Address,
  Hex,
  SignTypedDataParameters,
  TransactionRequest,
} from "viem";
import { decodeEventLog } from "viem";

// OperationPayload is defined in the base class module
type OperationPayload = {
  data: `0x${string}`;
  contractAddress: Address;
  value?: bigint;
};

// JobCreated event ABI matching the old v2 contract's JobManager
const JOB_CREATED_ABI = [
  {
    type: "event",
    name: "JobCreated",
    anonymous: false,
    inputs: [
      {
        name: "jobId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "accountId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "client",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "provider",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "evaluator",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "expiredAt",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
  },
] as const;

/**
 * Bridges the acp-node-v2 PrivyAlchemyEvmProviderAdapter to the old SDK's
 * BaseAcpContractClient interface. Only buyer-side methods are implemented.
 */
export class LegacyContractBridge extends BaseAcpContractClient {
  private chainId: number;

  constructor(
    agentWalletAddress: Address,
    config: AcpContractConfig,
    private provider: IEvmProviderAdapter
  ) {
    super(agentWalletAddress, config);
    this.chainId = config.chain.id;
  }

  async handleOperation(
    operations: OperationPayload[]
  ): Promise<{ userOpHash: Address; txnHash: Address }> {
    const calls = operations.map((op) => ({
      to: op.contractAddress,
      data: op.data,
      value: op.value,
    }));

    const result = await this.provider.sendCalls(this.chainId, calls);
    const txnHash = Array.isArray(result) ? result[0] : result;

    return { userOpHash: txnHash, txnHash };
  }

  async getJobId(
    createJobTxHash: Address,
    clientAddress: Address,
    providerAddress: Address
  ): Promise<number> {
    console.log("createJobTxHash", createJobTxHash);
    // Retry receipt fetch — bundled user-ops may take a moment to propagate
    let receipt = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        receipt = await this.provider.getTransactionReceipt(
          this.chainId,
          createJobTxHash
        );
        if (receipt) break;
      } catch {
        // Receipt not yet available
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!receipt) {
      throw new Error("Failed to get transaction receipt after retries");
    }

    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: JOB_CREATED_ABI,
          data: log.data,
          topics: log.topics,
        });

        if (
          decoded.eventName === "JobCreated" &&
          (decoded.args.client as string).toLowerCase() ===
            clientAddress.toLowerCase() &&
          (decoded.args.provider as string).toLowerCase() ===
            providerAddress.toLowerCase()
        ) {
          return Number(decoded.args.jobId);
        }
      } catch {
        // Not the event we're looking for
      }
    }

    throw new Error(
      `Failed to find JobCreated event in receipt (${receipt.logs.length} logs, tx: ${createJobTxHash})`
    );
  }

  async signTypedData(typedData: SignTypedDataParameters): Promise<Hex> {
    return (await this.provider.signTypedData(
      this.chainId,
      typedData
    )) as Hex;
  }

  async signMessage(message: string): Promise<Hex> {
    return (await this.provider.signMessage(this.chainId, message)) as Hex;
  }

  async sendTransaction(_request: TransactionRequest): Promise<Hex> {
    throw new Error("sendTransaction not supported via LegacyContractBridge");
  }

  async getAssetManager(): Promise<Address> {
    throw new Error("getAssetManager not supported via LegacyContractBridge");
  }

  getAcpVersion(): string {
    return "2";
  }

  async updateJobX402Nonce(): Promise<any> {
    throw new Error("X402 not supported via LegacyContractBridge");
  }

  async generateX402Payment(): Promise<any> {
    throw new Error("X402 not supported via LegacyContractBridge");
  }

  async performX402Request(): Promise<any> {
    throw new Error("X402 not supported via LegacyContractBridge");
  }
}
