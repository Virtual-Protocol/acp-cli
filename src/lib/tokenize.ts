import { erc20Abi, formatEther } from "viem";
import { createAgentFromConfig } from "./agentFactory";
import { EvmAcpClient } from "@virtuals-protocol/acp-node-v2";

function getEvmProvider() {
  return createAgentFromConfig().then((agent) => {
    const client = agent.getClient();
    if (!(client instanceof EvmAcpClient)) {
      throw new Error("Only EVM chains are supported for tokenization.");
    }
    return client.getProvider();
  });
}

export async function checkVirtualBalance(
  chainId: number,
  virtualToken: string,
  wallet: string,
  requiredWei: string
): Promise<void> {
  const provider = await getEvmProvider();
  const balance = (await provider.readContract(chainId, {
    abi: erc20Abi,
    address: virtualToken as `0x${string}`,
    functionName: "balanceOf",
    args: [wallet as `0x${string}`],
  })) as bigint;
  const required = BigInt(requiredWei);
  if (balance < required) {
    throw new Error(
      `Insufficient VIRTUAL balance. Need ${formatEther(
        required
      )}, have ${formatEther(balance)}.`
    );
  }
}

async function waitForReceipt(
  provider: Awaited<ReturnType<typeof getEvmProvider>>,
  chainId: number,
  txHash: `0x${string}`,
  { intervalMs = 2_000, timeoutMs = 120_000 } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = await provider.getTransactionReceipt(chainId, txHash);
      if (receipt.status === "reverted") {
        throw new Error(`Transaction ${txHash} reverted on-chain.`);
      }
      return;
    } catch (err) {
      if (err instanceof Error && err.message.includes("reverted")) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`Timed out waiting for receipt of ${txHash}`);
}

export async function sendApprove(
  chainId: number,
  virtualTokenAddress: string,
  approveCalldata: string
): Promise<string> {
  const provider = await getEvmProvider();
  const txHash = await provider.sendTransaction(chainId, {
    to: virtualTokenAddress as `0x${string}`,
    data: approveCalldata as `0x${string}`,
  });

  await waitForReceipt(provider, chainId, txHash as `0x${string}`);
  return txHash;
}

export async function sendPreLaunch(
  chainId: number,
  bondingV5Address: string,
  preLaunchCalldata: string
): Promise<string> {
  const provider = await getEvmProvider();
  const txHash = await provider.sendTransaction(chainId, {
    to: bondingV5Address as `0x${string}`,
    data: preLaunchCalldata as `0x${string}`,
  });

  await waitForReceipt(provider, chainId, txHash as `0x${string}`);
  return txHash;
}
