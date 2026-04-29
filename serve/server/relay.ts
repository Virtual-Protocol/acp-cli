import { io, type Socket } from "socket.io-client";
import type { LoadedHandlers } from "../runtime/loader";
import type { DeployedOffering, HandlerInput } from "../types";

export interface ServiceJobRelayOptions {
  apiUrl: string;
  agentToken: string;
}

interface ServiceJobRequest {
  jobId: string;
  protocol: "x402" | "mpp";
  clientAddress: string;
  requirements: Record<string, unknown>;
  payment: {
    txHash: string | null;
    paymentKey: string;
  };
}

interface ServiceJobAck {
  status: "completed" | "failed";
  deliverable?: unknown;
  error?: string;
}

export function serviceJobEndpoint(
  apiUrl: string,
  providerAddress: string,
  offeringSlug: string,
  protocol: "x402" | "mpp"
): string {
  return new URL(
    `/${protocol}/${providerAddress}/jobs/${encodeURIComponent(offeringSlug)}`,
    apiUrl
  ).toString();
}

export function startServiceJobRelay(
  offering: DeployedOffering,
  handlers: LoadedHandlers,
  options: ServiceJobRelayOptions
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

  socket.on(
    "service-job:request",
    async (request: ServiceJobRequest, ack: (response: ServiceJobAck) => void) => {
      try {
        const input: HandlerInput = {
          requirements: request.requirements,
          offering: offering.offering,
          jobId: request.jobId,
          client: { address: request.clientAddress },
          protocol: request.protocol,
        };
        const result = await handlers.handler(input);
        ack({ status: "completed", deliverable: result.deliverable });
      } catch (err) {
        ack({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  return socket;
}
