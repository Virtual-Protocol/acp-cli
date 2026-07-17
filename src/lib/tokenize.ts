import { erc20Abi, formatEther, parseUnits } from "viem";
import { createAgentFromConfig } from "./agentFactory";
import {
  EvmAcpClient,
  type ISolanaProviderAdapter,
} from "@virtuals-protocol/acp-node-v2";
import type {
  AgentApi,
  PrepareLaunchResponse,
  SolanaPrepareLaunchResponse,
} from "./api/agent";
import { toSolanaInstructionLike } from "./solana";
import { isSolanaChainId } from "./chains";
import { withApprovalGate } from "./walletGate";

export interface TokenizeParams {
  agentId: string;
  chainId: number;
  symbol: string;
  antiSniperTaxType?: number;
  needAcf?: boolean;
  isProject60days?: boolean;
  airdropPercent?: number;
  isRobotics?: boolean;
  prebuyVirtualBaseUnit: bigint;
  onProgress?: (message: string) => void;
}

export interface EvmTokenizeParams extends TokenizeParams {
  walletAddress: string;
}

export interface TokenizeResult {
  virtualId: number;
  txHash: string;
  launchFee: string;
}

export function convertPrebuyVirtual(
  raw: string,
  chainId: number
): bigint | null {
  const trimmed = raw.trim();
  if (!trimmed) return 0n;
  if (!/^\d*\.?\d+$/.test(trimmed)) return null;
  try {
    const decimals = isSolanaChainId(chainId) ? 9 : 18;
    const base = parseUnits(trimmed as `${number}`, decimals);
    return base < 0n ? null : base;
  } catch {
    return null;
  }
}

function getEvmProvider(chainId: number) {
  return createAgentFromConfig().then((agent) => {
    const client = agent.getClient(chainId);
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
  const provider = await getEvmProvider(chainId);
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
  const provider = await getEvmProvider(chainId);
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
  const provider = await getEvmProvider(chainId);
  const txHash = await provider.sendTransaction(chainId, {
    to: bondingV5Address as `0x${string}`,
    data: preLaunchCalldata as `0x${string}`,
  });

  await waitForReceipt(provider, chainId, txHash as `0x${string}`);
  return txHash;
}

export async function tokenizeOnSolana(
  agentApi: AgentApi,
  params: TokenizeParams,
  json?: boolean
): Promise<TokenizeResult> {
  const {
    agentId,
    chainId,
    symbol,
    antiSniperTaxType,
    needAcf,
    isProject60days,
    airdropPercent,
    isRobotics,
    prebuyVirtualBaseUnit,
    onProgress,
  } = params;

  let solanaLaunch: SolanaPrepareLaunchResponse;
  try {
    onProgress?.("\nPreparing token launch...");
    solanaLaunch = await agentApi.prepareSolanaLaunch(
      agentId,
      chainId,
      symbol,
      antiSniperTaxType,
      needAcf,
      isProject60days,
      airdropPercent,
      isRobotics,
      prebuyVirtualBaseUnit > 0n ? prebuyVirtualBaseUnit.toString() : undefined
    );
  } catch (err) {
    throw new Error(
      `Failed to prepare launch: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  let signature: string;
  try {
    onProgress?.("Launching token onchain...");

    if (!json && needAcf) {
      console.log(
        `Launch fee (with ACF): ${BigInt(solanaLaunch.launchFee) / BigInt(1e9)} VIRTUAL`
      );
    }
    if (!json && isRobotics) {
      console.log(`Robotics Launch: enabled (Eastworld eligibility).`);
    }

    const ixs = solanaLaunch.instructions.map(toSolanaInstructionLike);
    const result = await withApprovalGate(
      (provider: ISolanaProviderAdapter) => provider.sendInstructions(ixs),
      { chainId, sponsored: false }
    );

    // last instruction for token launch result
    signature = Array.isArray(result) ? result[result.length - 1] : result;
  } catch (err) {
    throw new Error(`Failed to launch token: ${err}`);
  }

  return {
    virtualId: solanaLaunch.virtualId,
    txHash: signature,
    launchFee: solanaLaunch.launchFee,
  };
}

export async function tokenizeOnEvm(
  agentApi: AgentApi,
  params: EvmTokenizeParams,
  json?: boolean
): Promise<TokenizeResult> {
  const {
    agentId,
    chainId,
    symbol,
    antiSniperTaxType,
    needAcf,
    isProject60days,
    airdropPercent = 0,
    isRobotics,
    prebuyVirtualBaseUnit,
    walletAddress,
    onProgress,
  } = params;

  let launch: PrepareLaunchResponse;
  try {
    onProgress?.("\nPreparing token launch...");
    launch = await agentApi.prepareLaunch(
      agentId,
      chainId,
      symbol,
      antiSniperTaxType,
      needAcf,
      isProject60days,
      airdropPercent,
      isRobotics,
      prebuyVirtualBaseUnit > 0n ? prebuyVirtualBaseUnit.toString() : undefined
    );
  } catch (err) {
    throw new Error(
      `Failed to prepare launch: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const {
    virtualId,
    contracts,
    launchFee,
    approveCalldata,
    preLaunchCalldata,
  } = launch;

  const launchFeeWei = BigInt(launchFee);
  const totalApprovalWei = launchFeeWei + prebuyVirtualBaseUnit;

  let preLaunchTxHash: string;
  try {
    await checkVirtualBalance(
      chainId,
      contracts.virtualToken,
      walletAddress,
      totalApprovalWei.toString()
    );
    if (!json && needAcf) {
      console.log(
        `Launch fee (with ACF): ${formatEther(launchFeeWei)} VIRTUAL`
      );
    }
    if (!json && isProject60days) {
      console.log(
        `60 Days Experiment enabled — pre-buy tokens will follow a 60-day cliff.`
      );
    }
    if (!json && airdropPercent > 0) {
      console.log(
        `Airdrop: allocating ${airdropPercent}% of supply to veVIRTUAL holders.`
      );
    }
    if (!json && isRobotics) {
      console.log(`Robotics Launch: enabled (Eastworld eligibility).`);
    }
    if (!json && prebuyVirtualBaseUnit > 0n) {
      console.log(
        `Pre-buying ${formatEther(prebuyVirtualBaseUnit)} VIRTUAL of $${symbol}`
      );
    }
    onProgress?.("Approving VIRTUAL token...");

    await sendApprove(chainId, contracts.virtualToken, approveCalldata);

    onProgress?.("Calling preLaunch contract...");
    preLaunchTxHash = await sendPreLaunch(
      chainId,
      contracts.bondingV5,
      preLaunchCalldata
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hints: string[] = [];
    if (needAcf && prebuyVirtualBaseUnit > 0n) {
      hints.push("with ACF enabled, pre-buy must be ≤50% of LP");
    }
    if (airdropPercent > 0 && prebuyVirtualBaseUnit > 0n) {
      hints.push(
        `airdrop reserves ${airdropPercent}% of supply before LP, reducing pre-buy headroom`
      );
    }
    const hint = hints.length
      ? ` Hint: ${hints.join("; ")}; reduce --prebuy and retry.`
      : "";
    throw new Error(`Failed to launch token: ${msg}${hint}`);
  }

  return {
    virtualId,
    txHash: preLaunchTxHash,
    launchFee: launchFeeWei.toString(),
  };
}
