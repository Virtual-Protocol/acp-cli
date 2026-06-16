// Base URL for the Virtuals web dashboard (the `virtual-protocol-app`
// frontend), where wallet-owner-gated operations — editing/deleting a policy,
// changing a live signer's policy — are signed with the user's Privy session.
//
// These are the dashboard's own canonical hosts (see virtual-protocol-app
// src/pages/acp/constants/url.ts; the `/acp/*` routes are served there).
// Override with ACP_DASHBOARD_URL if they ever change.
export function dashboardBaseUrl(): string {
  const override = process.env.ACP_DASHBOARD_URL?.trim();
  if (override) return override.replace(/\/$/, "");

  const isTestnet = process.env.IS_TESTNET === "true";
  return isTestnet
    ? "https://app-dev.virtuals.io"
    : "https://app.virtuals.io";
}

// The Wallet Policies library page (create/edit/delete custom policies). The
// page reads `policyId`/`action` query params to open a specific policy's
// edit (default) or delete dialog directly, so pass them to land the user on
// the exact policy rather than just the list.
export function dashboardWalletPoliciesUrl(opts?: {
  policyId?: string;
  action?: "edit" | "delete";
}): string {
  const base = `${dashboardBaseUrl()}/acp/wallet-policies`;
  if (!opts?.policyId) return base;
  const params = new URLSearchParams({ policyId: opts.policyId });
  if (opts.action) params.set("action", opts.action);
  return `${base}?${params.toString()}`;
}

// Deep link to where a *signer's* policy is changed: the agent's Wallet tab,
// Signers sub-tab. The FE reads `tab`/`subTab` query params to open directly.
// Falls back to the agents list when no agentId is known.
export function dashboardSignerPolicyUrl(agentId?: string): string {
  const base = dashboardBaseUrl();
  return agentId
    ? `${base}/acp/agents/${agentId}?tab=wallet&subTab=signers`
    : `${base}/acp/agents`;
}
