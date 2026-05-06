import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  authorizationTypes,
  eip3009ABI,
  isEIP3009Payload,
  isPermit2Payload,
} from "@x402/evm";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { DEFAULT_STABLECOINS } from "@x402/evm";
import { registerExactEvmScheme as registerExactEvmFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { registerExactEvmScheme as registerExactEvmServerScheme } from "@x402/evm/exact/server";
import {
  encodeFunctionData,
  getAddress,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { type IEvmProviderAdapter } from "@virtuals-protocol/acp-node-v2";
import type { DeployedOffering } from "../../types";
import {
  createProviderAdapter,
  getWalletAddress,
} from "../../../src/lib/agentFactory";
import { getDefaultChainId, getPublicClient, verifyTypedData } from "./chain";

export interface X402SettlementResult {
  clientAddress: string;
  paymentKey: string;
  txHash: string | null;
  alreadySettled?: boolean;
}

type X402Runtime = {
  network: Network;
  resourceServer: x402ResourceServer;
};

class LocalX402FacilitatorClient implements FacilitatorClient {
  constructor(private readonly facilitator: x402Facilitator) {}

  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  async getSupported(): Promise<SupportedResponse> {
    return this.facilitator.getSupported() as SupportedResponse;
  }
}

const runtimes = new Map<number, Promise<X402Runtime>>();

export async function buildX402PaymentChallenge(
  offering: DeployedOffering,
  resourceUrl: string
): Promise<{ header: string; body: PaymentRequired }> {
  const requirements = await buildRequirements(offering);
  const runtime = await getRuntimeForNetwork(requirements.network);
  const body = await runtime.resourceServer.createPaymentRequiredResponse(
    [requirements],
    {
      url: resourceUrl,
      description: offering.offering.description,
      mimeType: "application/json",
    },
    "Payment required",
    { bazaar: buildBazaarDiscovery(offering) }
  );

  return {
    body,
    header: encodePaymentRequiredHeader(body),
  };
}

export async function verifyAndSettleX402Payment(
  paymentHeader: string,
  offering: DeployedOffering
): Promise<X402SettlementResult> {
  const payload = decodePaymentPayload(paymentHeader);
  const expected = await buildRequirements(offering);
  const runtime = await getRuntimeForNetwork(expected.network);
  const matched = runtime.resourceServer.findMatchingRequirements(
    [expected],
    payload
  );
  if (!matched) {
    throw new Error("x402 payment requirements mismatch");
  }

  if (await isEip3009AuthorizationUsed(payload, matched)) {
    await assertRecoverableEip3009Payment(payload, matched);
    return {
      clientAddress: getAddress(extractPayer(payload)),
      paymentKey: buildPaymentKey(payload, matched),
      txHash: null,
      alreadySettled: true,
    };
  }

  const verifyResult = await runtime.resourceServer.verifyPayment(
    payload,
    matched
  );
  if (!verifyResult.isValid) {
    throw new Error(
      verifyResult.invalidMessage ||
        verifyResult.invalidReason ||
        "Invalid x402 payment signature"
    );
  }

  const settleResult = await runtime.resourceServer.settlePayment(
    payload,
    matched
  );
  if (!settleResult.success) {
    throw new Error(
      settleResult.errorMessage ||
        settleResult.errorReason ||
        "x402 payment settlement failed"
    );
  }

  return {
    clientAddress: getAddress(settleResult.payer || extractPayer(payload)),
    paymentKey: buildPaymentKey(payload, matched, settleResult),
    txHash: (settleResult.transaction as Hex | undefined) || null,
  };
}

export function buildX402PaymentResponse(result: X402SettlementResult): string {
  return encodePaymentResponseHeader({
    success: true,
    payer: result.clientAddress,
    transaction: result.txHash || "",
    network: `eip155:${getDefaultChainId()}`,
  });
}

async function buildRequirements(
  offering: DeployedOffering
): Promise<PaymentRequirements> {
  const chainId = getDefaultChainId();
  const network = `eip155:${chainId}` as Network;
  const asset = DEFAULT_STABLECOINS[network];
  if (!asset) {
    throw new Error(`Unsupported chain ${chainId}`);
  }
  const assetAddress = asset.address;
  const decimals = asset.decimals;
  const runtime = await getRuntime(chainId);

  const [requirements] =
    await runtime.resourceServer.buildPaymentRequirementsFromOptions(
      [
        {
          scheme: "exact",
          network,
          payTo: getAddress(offering.providerWallet),
          price: {
            asset: getAddress(assetAddress),
            amount: parseUnits(
              String(offering.offering.priceValue),
              decimals
            ).toString(),
            extra: {
              name: process.env.X402_ASSET_NAME || "USDC",
              version: process.env.X402_ASSET_VERSION || "2",
            },
          },
          maxTimeoutSeconds: Math.max(offering.offering.slaMinutes, 1) * 60,
        },
      ],
      undefined
    );

  if (!requirements) {
    throw new Error("Unable to build x402 requirements");
  }
  return requirements;
}

function buildBazaarDiscovery(
  offering: DeployedOffering
): Record<string, unknown> {
  const toBodySchema = (
    value: Record<string, unknown> | string
  ): Record<string, unknown> => {
    if (typeof value === "string") {
      return {
        type: "object",
        description: value,
        additionalProperties: true,
      };
    }
    return value.type ? value : { type: "object", ...value };
  };

  const toOutput = (
    value: Record<string, unknown> | string
  ): Record<string, unknown> =>
    typeof value === "string"
      ? { type: "json", example: value }
      : { type: "json", schema: value };

  return {
    info: {
      input: {
        type: "http",
        method: "POST",
        bodyType: "json",
        body: toBodySchema(offering.offering.requirements),
      },
      output: toOutput(offering.offering.deliverable),
    },
  };
}

function decodePaymentPayload(paymentHeader: string): PaymentPayload {
  try {
    return decodePaymentSignatureHeader(paymentHeader);
  } catch {
    throw new Error("Invalid x402 payment header");
  }
}

function getRuntimeForNetwork(network: Network): Promise<X402Runtime> {
  return getRuntime(Number(network.replace("eip155:", "")));
}

function getRuntime(chainId: number): Promise<X402Runtime> {
  let runtime = runtimes.get(chainId);
  if (!runtime) {
    runtime = createRuntime(chainId).catch((error) => {
      if (runtimes.get(chainId) === runtime) {
        runtimes.delete(chainId);
      }
      throw error;
    });
    runtimes.set(chainId, runtime);
  }
  return runtime;
}

async function createRuntime(chainId: number): Promise<X402Runtime> {
  const network = `eip155:${chainId}` as Network;
  const facilitator = new x402Facilitator();
  registerExactEvmFacilitatorScheme(facilitator, {
    signer: await buildFacilitatorSigner(chainId),
    networks: network,
  });

  const resourceServer = new x402ResourceServer(
    new LocalX402FacilitatorClient(facilitator)
  );
  registerExactEvmServerScheme(resourceServer, { networks: [network] });
  await resourceServer.initialize();

  return { network, resourceServer };
}

let providerAdapterPromise: Promise<IEvmProviderAdapter> | null = null;

function getProviderAdapter(): Promise<IEvmProviderAdapter> {
  if (!providerAdapterPromise) {
    providerAdapterPromise = createProviderAdapter();
  }
  return providerAdapterPromise;
}

async function buildFacilitatorSigner(
  chainId: number
): Promise<FacilitatorEvmSigner> {
  const publicClient = getPublicClient(chainId);
  const provider = await getProviderAdapter();
  const address = getAddress(getWalletAddress() as Address);

  const send = (args: { to: Address; data?: Hex; value?: bigint }) =>
    provider.sendTransaction(chainId, {
      to: args.to,
      ...(args.data !== undefined ? { data: args.data } : {}),
      ...(args.value !== undefined ? { value: args.value } : {}),
    }) as Promise<Hex>;

  return {
    getAddresses: () => [address],
    readContract: (args) => publicClient.readContract(args as any),
    verifyTypedData: (args) => verifyTypedData(args as any),
    writeContract: async (args) => {
      const data = encodeFunctionData({
        abi: args.abi,
        functionName: args.functionName,
        args: args.args,
      });
      return send({ to: args.address, data });
    },
    sendTransaction: (args) => send({ to: args.to, data: args.data }),
    waitForTransactionReceipt: (args) =>
      publicClient.waitForTransactionReceipt(args),
    getCode: (args) => publicClient.getCode(args),
  };
}

function extractPayer(payload: PaymentPayload): Address {
  const schemePayload = payload.payload as any;
  if (isEIP3009Payload(schemePayload)) {
    return getAddress(schemePayload.authorization.from);
  }
  if (isPermit2Payload(schemePayload)) {
    return getAddress(schemePayload.permit2Authorization.from);
  }
  throw new Error("Unsupported x402 EVM payload");
}

async function isEip3009AuthorizationUsed(
  payload: PaymentPayload,
  requirements: PaymentRequirements
): Promise<boolean> {
  const schemePayload = payload.payload as any;
  if (!isEIP3009Payload(schemePayload)) {
    return false;
  }

  const chainId = Number(requirements.network.replace("eip155:", ""));
  const publicClient = getPublicClient(chainId);
  return Boolean(
    await publicClient.readContract({
      address: getAddress(requirements.asset),
      abi: eip3009ABI,
      functionName: "authorizationState",
      args: [
        getAddress(schemePayload.authorization.from),
        schemePayload.authorization.nonce,
      ],
    })
  );
}

async function assertRecoverableEip3009Payment(
  payload: PaymentPayload,
  requirements: PaymentRequirements
): Promise<void> {
  const schemePayload = payload.payload as any;
  if (!isEIP3009Payload(schemePayload)) {
    throw new Error("Unsupported x402 replay payload");
  }

  const authorization = schemePayload.authorization;
  const extra = requirements.extra as
    | { name?: string; version?: string }
    | undefined;
  const signature = schemePayload.signature as Hex | undefined;
  if (!extra?.name || !extra.version || !signature) {
    throw new Error("Invalid x402 payment signature");
  }

  if (
    getAddress(authorization.to) !== getAddress(requirements.payTo) ||
    BigInt(authorization.value) !== BigInt(requirements.amount)
  ) {
    throw new Error("x402 payment requirements mismatch");
  }

  const isValid = await verifyTypedData({
    address: getAddress(authorization.from),
    domain: {
      name: extra.name,
      version: extra.version,
      chainId: Number(requirements.network.replace("eip155:", "")),
      verifyingContract: getAddress(requirements.asset),
    },
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
    signature,
  });

  if (!isValid) {
    throw new Error("Invalid x402 payment signature");
  }
}

function buildPaymentKey(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  settleResult?: SettleResponse
): string {
  const schemePayload = payload.payload as any;
  if (isEIP3009Payload(schemePayload)) {
    return `x402:${requirements.network}:${getAddress(requirements.asset)}:${
      schemePayload.authorization.nonce
    }`;
  }
  if (isPermit2Payload(schemePayload)) {
    return `x402:${requirements.network}:${getAddress(requirements.asset)}:${
      schemePayload.permit2Authorization.nonce
    }`;
  }
  if (!settleResult?.transaction) {
    throw new Error("Unsupported x402 payment payload");
  }
  return `x402:${requirements.network}:${getAddress(requirements.asset)}:${
    settleResult.transaction
  }`;
}
