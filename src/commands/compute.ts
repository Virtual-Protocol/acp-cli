import type { Command } from "commander";
import { execSync } from "child_process";
import * as readline from "readline";
import { encodeFunctionData, erc20Abi, isAddress, parseUnits } from "viem";
import { USDC_ADDRESSES, USDC_DECIMALS } from "@virtuals-protocol/acp-node-v2";
import { isJson, outputResult, outputError, isTTY } from "../lib/output";
import { c } from "../lib/color";
import { getClient } from "../lib/api/client";
import { printTable } from "../lib/prompt";
import { getActiveAgentId } from "../lib/activeAgent";
import { createProviderAdapter, getWalletAddress } from "../lib/agentFactory";
import { formatChainId, formatChainIds } from "../lib/chains";
import { CliError } from "../lib/errors";
import { openBrowser } from "../lib/browser";

// ── Registration ────────────────────────────────────────────────────

export function registerComputeCommands(program: Command): void {
  const compute = program
    .command("compute")
    .description("Manage agent compute (LLM-inference) accounts");

  compute
    .command("status")
    .description("Show the agent's compute account balance and settings")
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const account = await agentApi.getComputeAccount(agentId);

        if (json) {
          outputResult(json, account as unknown as Record<string, unknown>);
          return;
        }

        const rows: [string, string][] = [
          ["Limit", `$${Number(account.limit).toFixed(2)}`],
          ["Remaining", `$${Number(account.limitRemaining).toFixed(2)}`],
          ["Usage", `$${Number(account.usage).toFixed(2)}`],
        ];
        printTable(rows);
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  compute
    .command("top-up")
    .description(
      "Top up the compute account by transferring USDC to the ACP fee wallet"
    )
    .requiredOption("--amount <amount>", "Amount of USDC to top up (min 1)")
    .option(
      "--chain-id <id>",
      "Chain to send USDC on (defaults to the account's preferred billing chain)",
      "8453"
    )
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const amount = Number(opts.amount);
        if (!Number.isFinite(amount) || amount < 1 || amount > 1000) {
          throw new CliError(
            `Invalid --amount: ${opts.amount}`,
            "VALIDATION_ERROR",
            "Top up amount must be between 1 to 1000"
          );
        }

        const { agentApi } = await getClient();
        const agentId = getActiveAgentId(json);
        if (!agentId) return;

        const chainId = Number(opts.chainId);
        const usdcAddress = USDC_ADDRESSES[chainId];
        const usdcDecimals = USDC_DECIMALS[chainId];
        if (!usdcAddress || usdcDecimals === undefined) {
          throw new CliError(
            `USDC is not configured for chain ${chainId}.`,
            "VALIDATION_ERROR",
            `Supported chains: ${formatChainIds(
              Object.keys(USDC_ADDRESSES).map(Number)
            )}`
          );
        }

        const provider = await createProviderAdapter();
        const supportedChainIds = await provider.getSupportedChainIds();
        if (!supportedChainIds.includes(chainId)) {
          throw new CliError(
            `Unsupported chain ID: ${formatChainId(chainId)}`,
            "VALIDATION_ERROR",
            `Supported chains: ${formatChainIds(supportedChainIds)}`
          );
        }

        const { walletAddress: feeWallet, feeBps } =
          await agentApi.getComputeFeeData();

        const feeAmount = (amount * feeBps) / 10_000;
        const totalAmount = amount + feeAmount;

        const value = parseUnits(
          totalAmount.toFixed(usdcDecimals),
          usdcDecimals
        );

        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [feeWallet as `0x${string}`, value],
        });

        if (!json && isTTY()) {
          console.log(
            `  Transferring ${c.bold(`${totalAmount} USDC`)} to wallet ${c.dim(
              feeWallet
            )} on chain ${chainId}...`
          );
        }

        const txnHash = await provider.sendTransaction(chainId, {
          to: usdcAddress as `0x${string}`,
          data,
        });

        const agentAddress = getWalletAddress();
        const result = await agentApi.computeTopUp(
          agentId,
          agentAddress,
          amount,
          txnHash
        );

        if (json) {
          outputResult(json, {
            amount,
            totalAmount,
            chainId,
            feeWallet,
            txnHash,
          });
          return;
        }

        console.log(
          `\n${c.green(
            "Successfully top up your compute account, your balance will be increased shortly."
          )}`
        );
        printTable([
          ["Top Up Amount", `${amount} USDC`],
          ["Total Paid", `${totalAmount} USDC`],
          ["Chain", String(chainId)],
          ["Fee Wallet", feeWallet],
          ["Tx Hash", txnHash],
        ]);
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // Helper functions for apply
  function execCommand(cmd: string): string {
    try {
      return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "";
    }
  }

  function askQuestion(query: string, defaultValue: string): Promise<string> {
    const displayQuery = defaultValue ? `${query} [${defaultValue}]: ` : `${query}: `;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question(displayQuery, (ans) => {
        rl.close();
        resolve(ans.trim() || defaultValue);
      });
    });
  }

  compute
    .command("apply")
    .description("Apply for Venice developer compute credits ($200 approved)")
    .option("--github <handle>", "GitHub handle (auto-harvested if omitted)")
    .option("--email <email>", "Developer Email address (auto-harvested if omitted)")
    .option("--name <name>", "Full Name (auto-harvested if omitted)")
    .option("--linkedin <url>", "LinkedIn Profile URL")
    .option("--referral <code-or-referral>", "Referral code (Optional)")
    .option("--motivation <text>", "What will you build? (Optional)")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      const tty = isTTY() && !json;

      try {
        const { agentApi } = await getClient();
        const agentId = getActiveAgentId(json);
        if (!agentId) return;

        // Auto-harvest
        const harvestedName = opts.name || execCommand("git config --global user.name") || "Developer";
        const harvestedEmail = opts.email || execCommand("git config --global user.email") || "";
        let harvestedGithub = opts.github || execCommand("git config --global github.user") || execCommand("git config --global credential.username");
        if (!harvestedGithub) {
          try {
            harvestedGithub = execCommand("gh api user -q .login");
          } catch {}
        }

        // Get GitHub token
        const githubToken = process.env.GITHUB_TOKEN || execCommand("gh auth token");

        let name = harvestedName;
        let email = harvestedEmail;
        let github = harvestedGithub;
        let linkedin = opts.linkedin || "";
        let referral = opts.referral || "";
        let motivation = opts.motivation || "";

        if (tty) {
          console.log(`\n🚀 ${c.cyan("Venice-Virtuals Developer Inference Credit Campaign ($200 approved)")}`);
          console.log(`${c.dim("----------------------------------------------------------------------")}`);
          
          name = await askQuestion("  [1/6] Full Name", name);
          email = await askQuestion("  [2/6] Developer Email", email);
          github = await askQuestion("  [3/6] GitHub Username", github);
          console.log(`\n  [4/6] ${c.bold("LinkedIn Authentication (Security Verification)")}`);
          console.log(`        To protect credit pools, we use cryptographically verified LinkedIn profiles.`);
          
          try {
            const { verifyUrl, requestId } = await agentApi.getLinkedInVerifyUrl(agentId);
            
            console.log(`\n  ${c.cyan("👉 Please authenticate and authorize at this link:")}`);
            console.log(`     ${c.underline(verifyUrl)}\n`);
            
            // Open default system browser dynamically
            openBrowser(verifyUrl);
            
            console.log(`  ${c.yellow("⌛ Waiting for LinkedIn verification... (3-minute timeout)")}`);
            
            let verifiedUrl: string | undefined;
            const timeout = 180000; // 3 minutes
            const startTime = Date.now();
            
            while (Date.now() - startTime < timeout) {
              const status = await agentApi.checkLinkedInStatus(agentId, requestId);
              if (status.verified && status.url) {
                verifiedUrl = status.url;
                break;
              }
              await new Promise((r) => setTimeout(r, 4000)); // Poll every 4 seconds
            }
            
            if (!verifiedUrl) {
              throw new Error("Verification timed out or was cancelled by user.");
            }
            
            linkedin = verifiedUrl;
            console.log(`  ✅ ${c.green("Successfully Verified LinkedIn!")} Profile: ${linkedin}`);
            
          } catch (err: any) {
            console.log(`  ❌ ${c.red(`LinkedIn Auth Fallback: ${err.message}`)}`);
            linkedin = await askQuestion("     Enter LinkedIn Profile URL (Manual Entry Fallback)", linkedin);
          }
          referral = await askQuestion("  [5/6] Referral Code (Optional)", referral);
          motivation = await askQuestion("  [6/6] Motivation (What will you build? / Optional)", motivation);
        }

        if (!github) {
          throw new CliError(
            "Missing GitHub Handle",
            "VALIDATION_ERROR",
            "Please provide a GitHub handle using --github or configure your Git globally."
          );
        }

        if (!linkedin) {
          throw new CliError(
            "Missing LinkedIn URL",
            "VALIDATION_ERROR",
            "Please provide a LinkedIn profile URL using --linkedin."
          );
        }

        if (!githubToken && tty) {
          console.log(`\n⚠️  ${c.yellow("No active GitHub token detected.")}`);
          console.log(`   Please run ${c.bold("gh auth login")} or set the ${c.bold("GITHUB_TOKEN")} environment variable.`);
          console.log(`   We will attempt a public linking, but authenticated claims are recommended.\n`);
        }

        if (tty) {
          console.log(`\n⌛ ${c.dim("Submitting your application to the Venice-Virtuals Audit Engine...")}`);
        }

        // First we link GitHub
        await agentApi.linkDeveloperCampaignGithub(agentId, github, githubToken, undefined);
        
        // Then we enroll
        const enrollRes = await agentApi.enrollDeveloperCampaign(agentId, github, githubToken, undefined);

        if (json) {
          outputResult(json, {
            status: "success",
            github,
            email,
            enrollment: enrollRes,
          });
          return;
        }

        console.log(`\n${c.green("✅ Application Submitted & Processed Successfully!")}`);
        console.log(`\n${c.bold("📊 Venice-Virtuals Credit Claim Summary:")}`);
        printTable([
          ["Candidate Name", name],
          ["Developer Email", email],
          ["GitHub Handle", `@${github}`],
          ["LinkedIn Profile", linkedin],
          ["Referral Code", referral || "None"],
          ["Evaluation Status", c.green(enrollRes?.status || "active")],
          ["Weekly Credit Grant", `$${enrollRes?.weeklyCreditUsd || "200"}.00`],
        ]);

        console.log(`\nℹ️  ${c.dim("Your Venice compute credit has been fully linked and provisioned.")}`);
        console.log(`   Open ${c.bold("app.virtuals.io")} on your browser to see your updated Compute Dashboard!`);

      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
