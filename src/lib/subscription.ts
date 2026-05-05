import {
  AcpAgent,
  JobSession,
  AcpAgentSubscription,
  USDC_DECIMALS,
} from "@virtuals-protocol/acp-node-v2";
import { formatUnits, parseUnits } from "viem";
import { CliError } from "./errors";

export async function resolveSubscriptionAddon(
  agent: AcpAgent,
  session: JobSession,
  baseAmount: string,
  chainId: number,
  packageId: string | undefined
): Promise<{ subscription?: AcpAgentSubscription; totalBudget: number }> {
  if (!packageId) {
    return { totalBudget: Number(baseAmount) };
  }

  const packageIdNum = Number(packageId);
  if (!Number.isInteger(packageIdNum) || packageIdNum < 0) {
    throw new CliError(
      `Invalid --package-id "${packageId}" (must be a non-negative integer)`,
      "VALIDATION_ERROR",
      "Run `acp subscription list` to see your available agent subscriptions."
    );
  }

  const me = await agent.getMe();
  const subscription = me.subscriptions?.find(
    (s: AcpAgentSubscription) => s.packageId === packageIdNum
  );
  if (!subscription) {
    throw new CliError(
      `Agent subscription with package ID ${packageId} not found`,
      "VALIDATION_ERROR",
      "Run `acp subscription list` to see your available agent subscriptions."
    );
  }
  if (!session.job) {
    throw new CliError(
      `No job found for session ${session.chainId}`,
      "VALIDATION_ERROR",
      "Run `acp job list` to see your active jobs."
    );
  }

  const isActive = await agent.isSubscriptionActive(
    session.chainId,
    session.job.clientAddress,
    session.job.providerAddress,
    subscription.packageId
  );

  const usdcDecimals = USDC_DECIMALS[chainId];

  const jobBudgetWei = parseUnits(baseAmount, usdcDecimals);

  const totalBudgetWei = isActive
    ? jobBudgetWei
    : jobBudgetWei + parseUnits(String(subscription.price), usdcDecimals);

  const totalBudget = Number(formatUnits(totalBudgetWei, usdcDecimals));

  return { subscription, totalBudget };
}
