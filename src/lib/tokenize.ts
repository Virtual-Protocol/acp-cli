import { erc20Abi, formatEther, formatUnits, parseUnits } from "viem";
import { createAgentFromConfig } from "./agentFactory";
import {
  EvmAcpClient,
  getSplTokenBalance,
  type ISolanaProviderAdapter,
} from "@virtuals-protocol/acp-node-v2";
import type {
  AgentApi,
  OccupyLaunchOptions,
  OccupyQuoteToken,
  OccupyPrepareLaunchResponse,
  PrepareLaunchResponse,
  SolanaPrepareLaunchResponse,
  VirtualsPrepareLaunchResponse,
} from "./api/agent";
import { isOccupyLaunch } from "./api/agent";
import { toSolanaInstructionLike, type SolAddr } from "./solana";
import { isSolanaChainId } from "./chains";
import { withApprovalGate } from "./walletGate";
import { CliError } from "./errors";

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
  launchOptions?: OccupyLaunchOptions;
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

/**
 * Turn `--quote-token` (a symbol like NVDAc, or an address) into the full
 * record. The decimals matter: the tokenized equities are 8-decimal while
 * other allow-listed assets are 18, so a pre-buy converted against the wrong
 * one is off by orders of magnitude.
 */
export async function resolveQuoteToken(
  agentApi: AgentApi,
  chainId: number,
  quoteToken: string
): Promise<OccupyQuoteToken> {
  const tokens = await agentApi.listOccupyQuoteTokens(chainId);
  const wanted = quoteToken.trim().toLowerCase();
  const match = tokens.find(
    (t) =>
      t.symbol.toLowerCase() === wanted || t.address.toLowerCase() === wanted
  );
  if (!match) {
    throw new CliError(
      `Unknown quote token "${quoteToken}" on chain ${chainId}.`,
      "MISSING_QUOTE_TOKEN",
      `Available: ${tokens.map((t) => `${t.symbol} (${t.name})`).join(", ")}`
    );
  }
  return match;
}

/**
 * Occupy quotes its curve in an arbitrary asset, so a pre-buy is denominated in
 * that token's units rather than VIRTUAL's 18. Read the decimals rather than
 * assuming — an 8-decimal quote asset would otherwise overspend by 10^10.
 */
export function convertPrebuyWithDecimals(
  raw: string,
  decimals: number
): bigint | null {
  const trimmed = raw.trim();
  if (!trimmed) return 0n;
  if (!/^\d*\.?\d+$/.test(trimmed)) return null;
  try {
    const base = parseUnits(trimmed as `${number}`, decimals);
    return base < 0n ? null : base;
  } catch {
    return null;
  }
}

export async function checkTokenBalance(
  chainId: number,
  tokenAddress: string,
  wallet: string,
  requiredWei: string,
  label: string
): Promise<number> {
  const provider = await getEvmProvider(chainId);
  const [balance, decimals] = await Promise.all([
    provider.readContract(chainId, {
      abi: erc20Abi,
      address: tokenAddress as `0x${string}`,
      functionName: "balanceOf",
      args: [wallet as `0x${string}`],
    }) as Promise<bigint>,
    provider.readContract(chainId, {
      abi: erc20Abi,
      address: tokenAddress as `0x${string}`,
      functionName: "decimals",
    }) as Promise<number>,
  ]);
  const required = BigInt(requiredWei);
  if (balance < required) {
    throw new Error(
      `Insufficient ${label} balance. Need ${formatUnits(
        required,
        Number(decimals)
      )}, have ${formatUnits(balance, Number(decimals))}.`
    );
  }
  return Number(decimals);
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
  tokenAddress: string,
  approveCalldata: string
): Promise<string> {
  const provider = await getEvmProvider(chainId);
  const txHash = await provider.sendTransaction(chainId, {
    to: tokenAddress as `0x${string}`,
    data: approveCalldata as `0x${string}`,
  });

  await waitForReceipt(provider, chainId, txHash as `0x${string}`);
  return txHash;
}

export async function sendLaunch(
  chainId: number,
  bondingAddress: string,
  launchCalldata: string
): Promise<string> {
  const provider = await getEvmProvider(chainId);
  const txHash = await provider.sendTransaction(chainId, {
    to: bondingAddress as `0x${string}`,
    data: launchCalldata as `0x${string}`,
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
      async (provider: ISolanaProviderAdapter) => {
        // Preflight parity with the EVM path's checkVirtualBalance: the
        // wallet must cover launch fee + prebuy in the quote token (VIRTUAL,
        // 9 decimals on Solana) BEFORE broadcasting, so an underfunded
        // launch fails with a clear verdict instead of an on-chain error.
        // A missing token account reads as zero.
        const required =
          BigInt(solanaLaunch.launchFee) + prebuyVirtualBaseUnit;
        const owner = (await provider.getAddress()) as SolAddr;
        const { amount, decimals } = await getSplTokenBalance(
          provider.getRpc(chainId),
          owner,
          solanaLaunch.quoteMint as SolAddr
        );
        if (amount < required) {
          throw new CliError(
            `Insufficient VIRTUAL balance. Need ${formatUnits(
              required,
              decimals
            )}, have ${formatUnits(amount, decimals)}.`,
            "VALIDATION_ERROR"
          );
        }
        return provider.sendInstructions(chainId, ixs);
      },
      { chainId, sponsored: false }
    );

    // last instruction for token launch result
    signature = Array.isArray(result) ? result[result.length - 1] : result;
  } catch (err) {
    // Preflight verdicts are already user-facing; don't wrap them.
    if (err instanceof CliError) throw err;
    throw new Error(`Failed to launch token: ${err}`);
  }

  return {
    virtualId: solanaLaunch.virtualId,
    txHash: signature,
    launchFee: solanaLaunch.launchFee,
  };
}

/**
 * Occupy is single-phase and charges no launch fee: one `launch` call mints the
 * token, opens the pool and settles the pre-buy. So there is nothing to approve
 * unless the backend returned `approveCalldata` for a pre-buy, and the balance
 * to check is the quote token, not VIRTUAL.
 */
async function launchOnOccupy(
  launch: OccupyPrepareLaunchResponse,
  params: {
    chainId: number;
    symbol: string;
    prebuyBaseUnit: bigint;
    walletAddress: string;
    json?: boolean;
    onProgress?: (message: string) => void;
  }
): Promise<TokenizeResult> {
  const { chainId, symbol, prebuyBaseUnit, walletAddress, json, onProgress } =
    params;
  const { virtualId, contracts, approveCalldata, launchCalldata } = launch;

  try {
    if (!json) {
      // The venue and the quote asset are the two things a human most needs to
      // see before an irreversible launch: the curve is priced against a stock.
      console.log(
        `Launchpad: Occupy — no launch fee, one transaction, curve priced against ${contracts.quoteToken}`
      );
    }

    if (prebuyBaseUnit > 0n) {
      const decimals = await checkTokenBalance(
        chainId,
        contracts.quoteToken,
        walletAddress,
        prebuyBaseUnit.toString(),
        "quote token"
      );
      if (!json) {
        console.log(
          `Pre-buying $${symbol} with ${formatUnits(
            prebuyBaseUnit,
            decimals
          )} of ${contracts.quoteToken}`
        );
      }
      if (!approveCalldata) {
        throw new Error(
          "Backend returned no approveCalldata for a non-zero pre-buy"
        );
      }
      onProgress?.("Approving quote token...");
      await sendApprove(chainId, contracts.quoteToken, approveCalldata);
    }

    onProgress?.("Calling launch contract...");
    const txHash = await sendLaunch(chainId, contracts.bonding, launchCalldata);

    return { virtualId, txHash, launchFee: "0" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to launch token on Occupy: ${msg}`);
  }
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
    launchOptions,
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
      prebuyVirtualBaseUnit > 0n ? prebuyVirtualBaseUnit.toString() : undefined,
      launchOptions
    );
  } catch (err) {
    throw new Error(
      `Failed to prepare launch: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (isOccupyLaunch(launch)) {
    return launchOnOccupy(launch, {
      chainId,
      symbol,
      prebuyBaseUnit: prebuyVirtualBaseUnit,
      walletAddress,
      json,
      onProgress,
    });
  }

  const {
    virtualId,
    contracts,
    launchFee,
    approveCalldata,
    preLaunchCalldata,
  } = launch as VirtualsPrepareLaunchResponse;

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
