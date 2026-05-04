import { generateP256KeyPair } from "@privy-io/node";
import { execSync } from "child_process";
import { storeSignerKey } from "./signerKeychain";
import type { AgentApi, Agent } from "./api/agent";

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 5 * 60 * 1_000;

export interface DeploySignerDetails {
  publicKey: string;
  privateKey: string;
  signerUrl: string;
  requestId: string;
}

function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    execSync(`${cmd} "${url}"`, { stdio: "ignore" });
  } catch {
    // Silently fail — URL is printed to console as fallback.
  }
}

export async function provisionDeploySigner(
  agentApi: AgentApi,
  agent: Agent,
  offeringName: string,
  onStatus?: (message: string) => void
): Promise<DeploySignerDetails> {
  const keypair = await generateP256KeyPair();
  const addSigner = await agentApi.addSignerWithUrl(agent.id);
  const signerUrl = `${addSigner.data.url}&publicKey=${keypair.publicKey}`;
  const requestId = addSigner.data.requestId;

  onStatus?.([
    ``,
    `  Deploy signer required`,
    `  ──────────────────────`,
    `  A signing key is needed so the deployed service can act`,
    `  on behalf of agent "${agent.name}" for offering "${offeringName}".`,
    ``,
    `  Opening browser for approval...`,
    `  If it doesn't open, visit:`,
    `  ${signerUrl}`,
    ``,
    `  Waiting for approval (expires in 5 minutes)...`,
  ].join("\n"));

  openBrowser(signerUrl);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const status = await agentApi.getSignerStatus(agent.id, requestId);
      if (status.data.status === "completed") {
        onStatus?.("  Deploy signer approved.\n");
        await storeSignerKey(keypair.publicKey, keypair.privateKey);
        return {
          publicKey: keypair.publicKey,
          privateKey: keypair.privateKey,
          signerUrl,
          requestId,
        };
      }
    } catch {
      // Ignore transient polling errors and keep waiting until timeout.
    }
  }

  throw new Error("Signer registration timed out. Please try again.");
}
