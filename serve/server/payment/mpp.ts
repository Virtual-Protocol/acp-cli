import { randomBytes } from "crypto";
import { getAddress, type Hex } from "viem";
import type { DeployedOffering } from "../../types";
import {
  getDefaultChainId,
  getPublicClient,
  getSettlementAccount,
  getTokenDecimals,
  getUsdcAddress,
  toAtomicAmount,
} from "./chain";

type TempoHashPayload = {
  type: "hash";
  hash: `0x${string}`;
};

type TempoTransactionPayload = {
  type: "transaction";
  signature: `0x${string}`;
};

type TempoProofPayload = {
  type: "proof";
  signature: `0x${string}`;
};

type TempoPayload =
  | TempoHashPayload
  | TempoTransactionPayload
  | TempoProofPayload;

const localMppSecretKey = randomBytes(32).toString("hex");

export interface MppSettlementResult {
  clientAddress: string;
  paymentKey: string;
  txHash: string | null;
  receiptReference: string;
}

export async function buildMppPaymentChallenge(
  offering: DeployedOffering,
  nonce: string,
): Promise<string> {
  const handler = await createChargeHandler(offering, nonce);
  const result = await handler(buildRequest());
  if (result.status !== 402) {
    throw new Error("Unable to build MPP challenge");
  }

  const header = result.challenge.headers.get("WWW-Authenticate");
  if (!header) throw new Error("MPP challenge missing header");
  return header;
}

export async function verifyAndSettleMppPayment(
  authHeader: string,
  offering: DeployedOffering,
): Promise<MppSettlementResult> {
  const { Credential, Receipt } = await import("mppx");
  const credential = deserializeCredential(Credential, authHeader);
  const challenge = credential.challenge;
  const nonce = challenge.opaque?.nonce;
  if (!nonce) throw new Error("MPP challenge missing nonce");

  const source = parseDidPkh(credential.source);
  const request = challenge.request as any;
  const chainId = getChallengeChainId(request);
  if (source && source.chainId !== chainId) {
    throw new Error("MPP source chain does not match challenge");
  }

  const handler = await createChargeHandler(offering, nonce);
  const result = await handler(buildRequest({ Authorization: authHeader }));
  if (result.status === 402) {
    throw new Error(await result.challenge.text());
  }

  const response = result.withReceipt(new Response(null, { status: 200 }));
  const receiptHeader = response.headers.get("Payment-Receipt");
  if (!receiptHeader) throw new Error("MPP receipt missing");
  const receipt = Receipt.deserialize(receiptHeader);
  const txHash = isTxHash(receipt.reference) ? receipt.reference : null;

  return {
    clientAddress:
      source?.address || (await findReceiptPayer(chainId, receipt)),
    paymentKey: `mpp:${chainId}:${receipt.reference}`,
    receiptReference: receipt.reference,
    txHash,
  };
}

export function buildMppReceipt(result: MppSettlementResult): string {
  return Buffer.from(
    JSON.stringify({
      method: "tempo",
      reference: result.receiptReference || result.txHash || result.paymentKey,
      timestamp: new Date().toISOString(),
      status: "success",
    }),
  ).toString("base64url");
}

async function createChargeHandler(offering: DeployedOffering, nonce: string) {
  const chainId = getDefaultChainId();
  const asset = getUsdcAddress(chainId);
  const decimals = await getTokenDecimals(chainId, asset);
  const amount = toAtomicAmount(offering.offering.priceValue, decimals);
  const { Mppx, tempo } = await import("mppx/server");
  const payment = Mppx.create({
    secretKey: getSecretKey(),
    realm: getRealm(),
    methods: [
      tempo.charge({
        currency: getAddress(asset),
        decimals,
        feePayer: getSettlementAccount(),
        getClient: ({ chainId: requestedChainId }) =>
          getPublicClient(requestedChainId || chainId),
        recipient: getAddress(offering.providerWallet),
        waitForConfirmation: process.env.MPP_WAIT_FOR_CONFIRMATION !== "false",
      }),
    ],
  });

  return payment.tempo.charge({
    amount,
    chainId,
    description: offering.offering.description,
    expires: new Date(
      Date.now() + Math.max(offering.offering.slaMinutes, 1) * 60_000,
    ).toISOString(),
    feePayer: true,
    meta: {
      nonce,
      offeringId: String(offering.offering.id),
      offeringName: offering.offering.name,
    },
  });
}

function deserializeCredential(
  Credential: {
    deserialize<T>(value: string): {
      challenge: any;
      source?: string;
    };
  },
  authHeader: string,
) {
  try {
    return Credential.deserialize<TempoPayload>(authHeader);
  } catch {
    throw new Error("MPP credential is invalid");
  }
}

function buildRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${getRealm().replace(/\/$/, "")}/mpp/service-job`, {
    headers,
    method: "POST",
  });
}

function getSecretKey(): string {
  return (
    process.env.MPP_SECRET_KEY ||
    process.env.ACP_MPP_SECRET_KEY ||
    process.env.JWT_SECRET ||
    localMppSecretKey
  );
}

function getRealm(): string {
  return (
    process.env.MPP_REALM ||
    process.env.ACP_API_URL ||
    "https://acp-service-jobs.local"
  );
}

function getChallengeChainId(request: any): number {
  const chainId = Number(request?.methodDetails?.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error("MPP challenge chainId is invalid");
  }
  return chainId;
}

async function findReceiptPayer(
  chainId: number,
  receipt: { reference: string },
): Promise<string> {
  if (!isTxHash(receipt.reference)) {
    throw new Error("MPP credential source is required");
  }
  const txReceipt = await getPublicClient(chainId).getTransactionReceipt({
    hash: receipt.reference as Hex,
  });
  return getAddress(txReceipt.from);
}

function isTxHash(value: string): value is Hex {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function parseDidPkh(
  source?: string,
): { chainId: number; address: string } | null {
  if (!source) return null;
  const match = /^did:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40})$/.exec(source);
  if (!match) return null;
  return { chainId: Number(match[1]), address: getAddress(match[2]) };
}
