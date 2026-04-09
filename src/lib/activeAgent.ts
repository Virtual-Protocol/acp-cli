import { getActiveWallet, getAgentId } from "./config";
import { outputError } from "./output";
import { CliError } from "./errors";
import { AcpJobPhases } from "@virtuals-protocol/acp-node";

export function getActiveAgentId(json: boolean): string | null {
  const activeWallet = getActiveWallet();
  if (!activeWallet) {
    outputError(json, new CliError(
      "No active agent set.",
      "NO_ACTIVE_AGENT",
      "Run `acp agent use` to set an active agent."
    ));
    return null;
  }
  const agentId = getAgentId(activeWallet);
  if (!agentId) {
    outputError(json, new CliError(
      "Agent ID not found for active wallet.",
      "NO_ACTIVE_AGENT",
      "Run `acp agent list` or `acp agent use` to populate it."
    ));
    return null;
  }
  return agentId;
}

export function legacyAvailableTools(phase: AcpJobPhases): string[] {
  switch (phase) {
    case AcpJobPhases.NEGOTIATION:
      return ["fund"];
    case AcpJobPhases.EVALUATION:
      return ["complete", "reject"];
    default:
      return [];
  }
}
