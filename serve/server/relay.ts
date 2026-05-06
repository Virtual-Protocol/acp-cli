import { io, type Socket } from "socket.io-client";
import type { LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering, HandlerInput } from "../types";
import {
  buildX402PaymentChallenge,
  buildX402PaymentResponse,
  verifyAndSettleX402Payment,
} from "./payment/x402";
import {
  buildMppPaymentChallenge,
  buildMppReceipt,
  verifyAndSettleMppPayment,
} from "./payment/mpp";

export interface ServiceJobRelayOptions {
  apiUrl: string;
  agentToken: string;
  resolveOffering: (offeringId: string) => Promise<HandlerInput["offering"]>;
}

interface ServiceJobOffering {
  id: string;
  name: string;
  description: string;
  priceUsd: number;
  requirements: Record<string, unknown> | string;
  deliverable: Record<string, unknown> | string;
  slaMinutes: number;
}

interface PaymentChallengeRequest {
  protocol: "x402" | "mpp";
  providerAddress: string;
  offering: ServiceJobOffering;
  resourceUrl?: string;
  nonce?: string;
}

interface PaymentChallengeAck {
  status: "completed" | "failed";
  headers?: Record<string, string>;
  body?: unknown;
  error?: string;
}

interface ServiceJobRequest {
  jobId: string;
  protocol: "x402" | "mpp";
  providerAddress: string;
  clientAddress: string | null;
  offering: ServiceJobOffering;
  requirements: Record<string, unknown>;
  payment: {
    credential: string;
    txHash: string | null;
    paymentKey: string;
  };
}

interface PaymentSettlementAck {
  clientAddress?: string | null;
  paymentKey?: string;
  txHash?: string | null;
  receiptReference?: string;
}

interface ServiceJobAck {
  status: "completed" | "failed";
  deliverable?: unknown;
  headers?: Record<string, string>;
  settlement?: PaymentSettlementAck;
  error?: string;
}

export function serviceJobEndpoint(
  apiUrl: string,
  providerAddress: string,
  offeringSlug: string,
  protocol: "x402" | "mpp",
): string {
  return new URL(
    `/${protocol}/${providerAddress}/jobs/${encodeURIComponent(offeringSlug)}`,
    apiUrl,
  ).toString();
}

export function startServiceJobRelay(
  offering: DeployedOffering,
  handlers: LoadedHandlers,
  options: ServiceJobRelayOptions,
): Socket {
  const socket = io(new URL("/service-jobs", options.apiUrl).toString(), {
    auth: { token: options.agentToken },
    transports: ["websocket"],
  });

  socket.on("connect", () => {
    console.log(`[Relay] Connected to ACP service jobs (${socket.id})`);
  });
  socket.on("connect_error", (err) => {
    console.error(`[Relay] Connection failed: ${err.message}`);
  });
  socket.on("disconnect", (reason) => {
    console.log(`[Relay] Disconnected from ACP service jobs: ${reason}`);
  });

  const resolveLiveOffering = async (
    request: PaymentChallengeRequest | ServiceJobRequest,
  ): Promise<DeployedOffering> => {
    if (
      request.providerAddress.toLowerCase() !==
      offering.providerWallet.toLowerCase()
    ) {
      throw new Error("Relay request provider does not match this runtime");
    }
    if (request.offering.id !== offering.offeringId) {
      throw new Error("Relay request offering does not match this runtime");
    }
    const fresh = await options.resolveOffering(request.offering.id);
    return { ...offering, offering: fresh, offeringId: fresh.id };
  };

  socket.on(
    "service-job:payment-challenge",
    async (
      request: PaymentChallengeRequest,
      ack: (response: PaymentChallengeAck) => void,
    ) => {
      try {
        const live = await resolveLiveOffering(request);
        if (request.protocol === "x402") {
          const challenge = await buildX402PaymentChallenge(
            live,
            request.resourceUrl ||
              serviceJobEndpoint(
                options.apiUrl,
                live.providerWallet,
                live.offering.slug || live.offering.id,
                "x402",
              ),
          );
          ack({
            status: "completed",
            headers: { "Payment-Required": challenge.header },
            body: challenge.body,
          });
          return;
        }

        const header = await buildMppPaymentChallenge(
          live,
          request.nonce || `${Date.now()}`,
        );
        ack({
          status: "completed",
          headers: {
            "WWW-Authenticate": header,
            "Cache-Control": "no-store",
          },
          body: { error: "Payment required" },
        });
      } catch (err) {
        ack({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  socket.on(
    "service-job:request",
    async (
      request: ServiceJobRequest,
      ack: (response: ServiceJobAck) => void,
    ) => {
      try {
        const live = await resolveLiveOffering(request);
        const payment = await verifyAndSettlePayment(live, request);
        const input: HandlerInput = {
          requirements: request.requirements,
          offering: live.offering,
          jobId: request.jobId,
          client: { address: payment.clientAddress },
          protocol: request.protocol,
        };
        const result = await handlers.handler(input);
        ack({
          status: "completed",
          deliverable: result.deliverable,
          headers: payment.headers,
          settlement: payment.settlement,
        });
      } catch (err) {
        ack({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  return socket;
}

async function verifyAndSettlePayment(
  offering: DeployedOffering,
  request: ServiceJobRequest,
): Promise<{
  clientAddress: string;
  headers: Record<string, string>;
  settlement: PaymentSettlementAck;
}> {
  if (request.protocol === "x402") {
    const settlement = await verifyAndSettleX402Payment(
      request.payment.credential,
      offering,
    );
    return {
      clientAddress: settlement.clientAddress,
      headers: { "Payment-Response": buildX402PaymentResponse(settlement) },
      settlement,
    };
  }

  const settlement = await verifyAndSettleMppPayment(
    request.payment.credential,
    offering,
  );
  return {
    clientAddress: settlement.clientAddress,
    headers: { "Payment-Receipt": buildMppReceipt(settlement) },
    settlement,
  };
}
