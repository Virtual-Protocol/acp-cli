import type { HandlerInput, DeployedOffering } from "../../types";

export function buildHandlerInput(
  offering: DeployedOffering,
  requirements: Record<string, unknown> | string,
  clientAddress: string,
  protocol: HandlerInput["protocol"],
  jobId?: string
): HandlerInput {
  return {
    requirements,
    offering: offering.offering,
    jobId,
    client: { address: clientAddress },
    protocol,
  };
}
