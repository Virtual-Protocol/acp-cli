import type { Command } from "commander";
import type { JobSession, JobRoomEntry } from "acp-node-v2";
import {
  isJson,
  outputResult,
  outputError,
  isTTY,
  maskAddress,
} from "../lib/output";
import { c } from "../lib/color";
import type { AcpAgent } from "acp-node-v2";
import {
  getWalletAddress,
  createAgentFromConfig,
  createLegacyBuyerAdapter,
} from "../lib/agentFactory";
import { getClient } from "../lib/api/client";
import { formatUnits } from "viem";
import { isLegacyJob, getLegacyJobChainId } from "../lib/config";
import { LegacyBuyerAdapter } from "../lib/compat/legacyBuyerAdapter";
import { AcpJobPhases, AcpJob, AcpMemo } from "@virtuals-protocol/acp-node";

export function registerJobCommands(program: Command): void {
  const job = program.command("job").description("Job queries and monitoring");

  job
    .command("list")
    .description("List active jobs (REST, no socket connection needed)")
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);
      try {
        const agent = await createAgentFromConfig();
        const v2Jobs = await agent.getApi().getActiveJobs();

        const taggedV2 = v2Jobs.map((j: any) => ({ ...j, legacy: false }));

        // Also fetch legacy jobs
        let taggedLegacy: any[] = [];
        try {
          const adapter = await createLegacyBuyerAdapter();
          const legacyJobs = await adapter.getActiveJobs();
          taggedLegacy = legacyJobs.map((j) => ({
            onChainJobId: String(j.id),
            chainId: adapter.chainId,
            clientAddress: j.clientAddress,
            providerAddress: j.providerAddress,
            evaluatorAddress: j.evaluatorAddress,
            budget: String(j.price),
            jobStatus: LegacyBuyerAdapter.phaseToStatus(j.phase),
            expiredAt: "",
            legacy: true,
          }));
        } catch {
          // Legacy fetch failed — continue with v2 only
        }

        const allJobs = [...taggedV2, ...taggedLegacy];

        if (json) {
          outputResult(true, { jobs: allJobs });
        } else {
          if (allJobs.length === 0) {
            console.log("No active jobs.");
          } else if (isTTY()) {
            console.log(`${c.bold(`Active jobs (${allJobs.length}):`)}\n`);
            for (const j of allJobs) {
              console.log(
                `  ${c.bold("Job ID:")}           ${c.cyan(j.onChainJobId)}${
                  j.legacy ? c.dim(" [legacy]") : ""
                }`
              );
              console.log(`  ${c.bold("Chain ID:")}         ${j.chainId}`);
              console.log(
                `  ${c.bold("Client:")}           ${c.dim(j.clientAddress)}`
              );
              console.log(
                `  ${c.bold("Provider:")}         ${c.dim(j.providerAddress)}`
              );
              console.log(
                `  ${c.bold("Evaluator:")}        ${c.dim(j.evaluatorAddress)}`
              );
              if (!j.legacy) {
                console.log(
                  `  ${c.bold("Budget:")}           ${
                    j.budget
                      ? `${formatUnits(BigInt(j.budget), 6)} USDC`
                      : "N/A"
                  }`
                );
              }
              console.log(
                `  ${c.bold("Status:")}           ${c.status(j.jobStatus)}`
              );
              if (j.expiredAt) {
                console.log(
                  `  ${c.bold("Expires At:")}       ${c.dim(j.expiredAt)}`
                );
              }
              console.log();
            }
          } else {
            console.log(
              "JOB_ID\tCHAIN\tCLIENT\tPROVIDER\tBUDGET\tSTATUS\tLEGACY"
            );
            for (const j of allJobs) {
              const budget = !j.legacy
                ? formatUnits(BigInt(j.budget), 6)
                : j.budget;
              console.log(
                `${j.onChainJobId}\t${j.chainId}\t${j.clientAddress}\t${j.providerAddress}\t${budget}\t${j.jobStatus}\t${j.legacy}`
              );
            }
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  job
    .command("history")
    .description(
      "Get full job history including status and all messages (REST, no socket connection needed)"
    )
    .requiredOption("--job-id <id>", "On-chain job ID")
    .requiredOption("--chain-id <id>", "Chain ID")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        if (isLegacyJob(opts.jobId)) {
          const legacyChainId =
            getLegacyJobChainId(opts.jobId) ?? Number(opts.chainId);
          const adapter = await createLegacyBuyerAdapter();
          const legacyJob = await adapter.getJob(Number(opts.jobId));
          if (!legacyJob) {
            throw new Error(`Legacy job ${opts.jobId} not found`);
          }

          const agent = await createAgentFromConfig();
          const status = LegacyBuyerAdapter.phaseToStatus(legacyJob.phase);
          const deliverable = legacyJob.getDeliverable();
          const budget = legacyJob.price;

          const fundRequestMemo = legacyJob.memos.find(
            (m: AcpMemo) =>
              m.payableDetails && m.nextPhase === AcpJobPhases.NEGOTIATION
          );
          const fundRequest = fundRequestMemo
            ? await extractLegacyPayableInfo(
                fundRequestMemo,
                legacyChainId,
                agent
              )
            : null;

          const completedMemo = legacyJob.memos.find(
            (m: AcpMemo) =>
              m.payableDetails && m.nextPhase === AcpJobPhases.COMPLETED
          );
          const fundTransfer = completedMemo
            ? await extractLegacyPayableInfo(
                completedMemo,
                legacyChainId,
                agent
              )
            : null;

          const memoEntries = await Promise.all(
            legacyJob.memos.map(async (m: AcpMemo) => ({
              kind: "message" as const,
              from: m.senderAddress,
              content: m.content,
              contentType: "text",
              timestamp: Date.now(),
              ...(m.payableDetails
                ? {
                    payableDetails: await extractLegacyPayableInfo(
                      m,
                      legacyChainId,
                      agent
                    ),
                  }
                : {}),
            }))
          );

          if (json) {
            outputResult(true, {
              jobId: opts.jobId,
              chainId: legacyChainId,
              legacy: true,
              status,
              budget,
              ...(fundRequest ? { fundRequest } : {}),
              ...(fundTransfer ? { fundTransfer } : {}),
              ...(deliverable ? { deliverable } : {}),
              entryCount: memoEntries.length,
              entries: memoEntries,
            });
          } else if (isTTY()) {
            console.log(`Job ${opts.jobId} (chain ${legacyChainId}) [legacy]`);
            console.log(`Status: ${status}`);
            console.log(`Budget: ${budget}`);
            if (fundRequest)
              console.log(
                `Fund Request: ${fundRequest.amount} ${fundRequest.symbol}`
              );
            if (fundTransfer)
              console.log(
                `Fund Transfer: ${fundTransfer.amount} ${fundTransfer.symbol}`
              );
            if (deliverable)
              console.log(
                `Deliverable: ${
                  typeof deliverable === "string"
                    ? deliverable
                    : JSON.stringify(deliverable)
                }`
              );
            console.log(`Memos: ${memoEntries.length}\n`);
            for (const e of memoEntries) {
              console.log(`  [${e.from}] ${e.content}`);
            }
          } else {
            console.log(`${opts.jobId}\t${status}\t${memoEntries.length}`);
            for (const e of memoEntries) {
              console.log(`${e.from}\t${e.content}`);
            }
          }
          return;
        }

        // Default: v2 flow
        const wallet = getWalletAddress();

        const { jobApi } = await getClient(wallet);
        const entries = await jobApi.getChatHistory(
          Number(opts.chainId),
          opts.jobId
        );

        const status = deriveStatus(entries);

        if (json) {
          outputResult(true, {
            jobId: opts.jobId,
            chainId: Number(opts.chainId),
            protocol: "v2",
            status,
            entryCount: entries.length,
            entries,
          });
        } else if (isTTY()) {
          console.log(
            `${c.bold(`Job ${opts.jobId}`)} ${c.dim(
              `(chain ${opts.chainId})`
            )} [v2]`
          );
          console.log(`Status: ${c.status(status)}`);
          console.log(`Entries: ${entries.length}\n`);
          for (const e of entries) {
            if (e.kind === "system") {
              console.log(`  ${c.dim("[system]")} ${c.cyan(e.event.type)}`);
            } else {
              console.log(
                `  ${c.dim(`[${maskAddress(e.from)}]`)} ${e.content}`
              );
            }
          }
        } else {
          console.log(`${opts.jobId}\t${status}\t${entries.length}`);
          for (const e of entries) {
            if (e.kind === "system") {
              console.log(`system\t${e.event.type}`);
            } else {
              console.log(`${e.from}\t${e.content}`);
            }
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  job
    .command("watch")
    .description(
      "Block until the job needs your action, then print the event and exit. " +
        "This is a blocking command — use it as a background process or subagent task."
    )
    .requiredOption("--job-id <id>", "On-chain job ID")
    .option("--timeout <seconds>", "Timeout in seconds (default: no timeout)")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const jobId: string = opts.jobId;
        const timeoutSec: number | undefined = opts.timeout
          ? Number(opts.timeout)
          : undefined;

        let settled = false;

        const done = (exitCode: number, data?: Record<string, unknown>) => {
          if (settled) return;
          settled = true;
          if (data) {
            if (json) {
              process.stdout.write(JSON.stringify(data) + "\n");
            } else {
              const status = data.status as string;
              const tools = data.availableTools as string[];
              if (tools && tools.length > 0) {
                console.log(`\nJob #${jobId} needs your action`);
                console.log(`  Status: ${status}`);
                console.log(`  Available: ${tools.join(", ")}`);
              } else {
                console.log(
                  `\nJob #${jobId} reached terminal state: ${status}`
                );
              }
            }
          }
          process.exit(exitCode);
        };

        // Timeout handler
        if (timeoutSec) {
          setTimeout(() => {
            if (!settled) {
              outputError(
                json,
                `Timed out after ${timeoutSec}s waiting for job ${jobId}`
              );
              process.exit(4);
            }
          }, timeoutSec * 1000);
        }

        if (isLegacyJob(jobId)) {
          // Legacy: watch via old SDK's onNewTask socket
          const legacyChainId = getLegacyJobChainId(jobId);
          const agent = await createAgentFromConfig();
          await createLegacyBuyerAdapter({
            onNewTask: async (job: AcpJob, memoToSign?: AcpMemo) => {
              if (String(job.id) !== jobId) return;

              const status = LegacyBuyerAdapter.phaseToStatus(job.phase);
              const tools = legacyAvailableTools(job.phase);
              const actionable = tools.filter((t) => t !== "wait");

              const deliverable = job.getDeliverable();
              const budget = job.price;
              const chainId = legacyChainId ?? 84532;

              let fundRequest = null;
              if (
                memoToSign?.payableDetails &&
                job.phase === AcpJobPhases.NEGOTIATION
              ) {
                fundRequest = await extractLegacyPayableInfo(
                  memoToSign,
                  chainId,
                  agent
                );
              }

              const completedMemo = job.memos.find(
                (m: AcpMemo) =>
                  m.payableDetails && m.nextPhase === AcpJobPhases.COMPLETED
              );
              const fundTransfer = completedMemo
                ? await extractLegacyPayableInfo(completedMemo, chainId, agent)
                : null;

              const eventData: Record<string, unknown> = {
                jobId,
                chainId,
                status,
                legacy: true,
                roles: ["client"],
                availableTools: tools,
                budget,
                ...(fundRequest ? { fundRequest } : {}),
                ...(fundTransfer ? { fundTransfer } : {}),
                ...(deliverable ? { deliverable } : {}),
              };

              if (status === "completed") return done(1, eventData);
              if (status === "rejected") return done(2, eventData);
              if (status === "expired") return done(3, eventData);
              if (actionable.length > 0) return done(0, eventData);
            },
          });

          process.stderr.write(`Watching legacy job ${jobId}...\n`);
        } else {
          // V2: watch via SSE
          const agent = await createAgentFromConfig();

          agent.on(
            "entry",
            async (session: JobSession, _entry: JobRoomEntry) => {
              if (session.jobId !== jobId) return;

              const status = session.status;
              const tools = session.availableTools().map((t) => t.name);
              const actionable = tools.filter((t) => t !== "wait");

              const eventData = {
                jobId: session.jobId,
                chainId: session.chainId,
                status,
                roles: session.roles,
                availableTools: tools,
                entry: _entry,
              };

              if (status === "completed") return done(1, eventData);
              if (status === "rejected") return done(2, eventData);
              if (status === "expired") return done(3, eventData);
              if (actionable.length > 0) return done(0, eventData);
            }
          );

          await agent.start();

          process.stderr.write(`Watching job ${jobId}...\n`);
        }

        const shutdown = () => {
          if (!settled) {
            settled = true;
            process.exit(0);
          }
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
        process.exit(4);
      }
    });
}

async function extractLegacyPayableInfo(
  memo: AcpMemo,
  chainId: number,
  agent: AcpAgent
) {
  const pd = memo.payableDetails!;
  const token = await agent.resolveRawAssetToken(pd.token, pd.amount, chainId);
  return {
    amount: token.amount,
    tokenAddress: token.address,
    symbol: token.symbol,
    recipient: pd.recipient,
  };
}

function legacyAvailableTools(phase: AcpJobPhases): string[] {
  switch (phase) {
    case AcpJobPhases.NEGOTIATION:
      return ["fund"];
    case AcpJobPhases.EVALUATION:
      return ["complete", "reject"];
    default:
      return [];
  }
}

type JobStatus =
  | "open"
  | "budget_set"
  | "funded"
  | "submitted"
  | "completed"
  | "rejected"
  | "expired";

const EVENT_TO_STATUS: Record<string, JobStatus> = {
  "job.created": "open",
  "budget.set": "budget_set",
  "job.funded": "funded",
  "job.submitted": "submitted",
  "job.completed": "completed",
  "job.rejected": "rejected",
  "job.expired": "expired",
};

function deriveStatus(
  entries: Array<{ kind: string; event?: { type: string } }>
): JobStatus {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.kind === "system" && entry.event) {
      const mapped = EVENT_TO_STATUS[entry.event.type];
      if (mapped) return mapped;
    }
  }
  return "open";
}
