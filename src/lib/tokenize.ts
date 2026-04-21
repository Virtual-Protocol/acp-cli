import { encodeFunctionData, erc20Abi, formatEther } from "viem";
import { bondingV5Abi } from "../abis/bondingV5Abi";
import { bondingConfigAbi } from "../abis/bondingConfigAbi";
import { createAgentFromConfig } from "./agentFactory";
import { EvmAcpClient } from "@virtuals-protocol/acp-node-v2";

export interface LaunchConfig {
  antiSniperTaxType: number;
  airdropBips: number;
  needAcf: boolean;
  isProject60days: boolean;
  launchMode: number;
  purchaseAmount: string;
  startTime: number;
}

export const DEFAULT_LAUNCH_CONFIG: LaunchConfig = {
  antiSniperTaxType: 1,
  airdropBips: 0,
  needAcf: false,
  isProject60days: false,
  launchMode: 0,
  purchaseAmount: "0",
  startTime: 0,
};

function getEvmProvider() {
  return createAgentFromConfig().then((agent) => {
    const client = agent.getClient();
    if (!(client instanceof EvmAcpClient)) {
      throw new Error("Only EVM chains are supported for tokenization.");
    }
    return client.getProvider();
  });
}

export async function approveVirtualToken(
  chainId: number,
  virtualTokenAddress: string,
  spender: string,
  amount: string
): Promise<string> {
  const provider = await getEvmProvider();
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender as `0x${string}`, BigInt(amount)],
  });

  const txHash = await provider.sendTransaction(chainId, {
    to: virtualTokenAddress as `0x${string}`,
    data,
  });

  await waitForReceipt(provider, chainId, txHash as `0x${string}`);
  return txHash;
}

export async function readLaunchFee(
  chainId: number,
  bondingConfig: string,
  needAcf: boolean
): Promise<bigint> {
  const provider = await getEvmProvider();
  return (await provider.readContract(chainId, {
    abi: bondingConfigAbi,
    address: bondingConfig as `0x${string}`,
    functionName: "calculateLaunchFee",
    args: [false, needAcf],
  })) as bigint;
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
      await provider.getTransactionReceipt(chainId, txHash);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`Timed out waiting for receipt of ${txHash}`);
}

export async function callPreLaunch(
  chainId: number,
  bondingV5Address: string,
  agent: { name: string; imageUrl?: string },
  symbol: string,
  launchFee: string,
  config: LaunchConfig
): Promise<string> {
  const provider = await getEvmProvider();
  const data = encodeFunctionData({
    abi: bondingV5Abi,
    functionName: "preLaunch",
    args: [
      agent.name,
      symbol,
      [0, 1, 2, 4],
      "",
      agent.imageUrl ?? "",
      ["", "", "", ""],
      BigInt(launchFee) + BigInt(config.purchaseAmount),
      BigInt(config.startTime),
      config.launchMode,
      config.airdropBips,
      config.needAcf,
      config.antiSniperTaxType,
      config.isProject60days,
    ],
  });

  const txHash = await provider.sendTransaction(chainId, {
    to: bondingV5Address as `0x${string}`,
    data,
  });

  await waitForReceipt(provider, chainId, txHash);
  return txHash;
}
