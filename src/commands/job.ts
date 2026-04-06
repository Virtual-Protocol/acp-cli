import type { Command } from "commander";
import type { JobSession, JobRoomEntry } from "acp-node-v2";
import { isJson, outputResult, outputError, isTTY } from "../lib/output";
import { getWalletAddress, createAgentFromConfig } from "../lib/agentFactory";
import { getClient } from "../lib/api/client";
import { formatUnits } from "viem";

export function registerJobCommands(program: Command): void {
  const job = program.command("job").description("Job queries and monitoring");

  job
    .command("list")
    .description("List active jobs (REST, no socket connection needed)")
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);
      try {
        const wallet = getWalletAddress();

        const { jobApi } = await getClient(wallet);
        const jobs = await jobApi.getActiveJobs();

        if (json) {
          outputResult(true, { jobs });
        } else {
          if (jobs.length === 0) {
            console.log("No active jobs.");
          } else if (isTTY()) {
            console.log(`Active jobs (${jobs.length}):\n`);
            for (const j of jobs) {
              console.log(`  Job ID:           ${j.onChainJobId}`);
              console.log(`  Chain ID:         ${j.chainId}`);
              console.log(`  Client:           ${j.clientAddress}`);
              console.log(`  Provider:         ${j.providerAddress}`);
              console.log(`  Evaluator:        ${j.evaluatorAddress}`);
              console.log(
                `  Budget:           ${formatUnits(BigInt(j.budget), 6)} USDC`
              );
              console.log(`  Status:           ${j.jobStatus}`);
              console.log(`  Expires At:       ${j.expiredAt}`);
              console.log();
            }
          } else {
            console.log("JOB_ID\tCHAIN\tCLIENT\tPROVIDER\tBUDGET\tSTATUS");
            for (const j of jobs) {
              console.log(
                `${j.onChainJobId}\t${j.chainId}\t${j.clientAddress}\t${j.providerAddress}\t${formatUnits(BigInt(j.budget), 6)}\t${j.jobStatus}`
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
    .requiredOption("--chain-id <id>", "Chain ID", "84532")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
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
            status,
            entryCount: entries.length,
            entries,
          });
        } else if (isTTY()) {
          console.log(`Job ${opts.jobId} (chain ${opts.chainId})`);
          console.log(`Status: ${status}`);
          console.log(`Entries: ${entries.length}\n`);
          for (const e of entries) {
            if (e.kind === "system") {
              console.log(`  [system] ${e.event.type}`);
            } else {
              console.log(`  [${e.from}] ${e.content}`);
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
        const agent = await createAgentFromConfig();

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
                console.log(`\nJob #${jobId} reached terminal state: ${status}`);
              }
            }
          }
          agent.stop().then(() => process.exit(exitCode));
        };

        agent.on("entry", async (session: JobSession, _entry: JobRoomEntry) => {
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

          // Terminal states
          if (status === "completed") return done(1, eventData);
          if (status === "rejected") return done(2, eventData);
          if (status === "expired") return done(3, eventData);

          // Actionable — agent has something to do
          if (actionable.length > 0) return done(0, eventData);
        });

        // Timeout handler
        if (timeoutSec) {
          setTimeout(() => {
            if (!settled) {
              outputError(json, `Timed out after ${timeoutSec}s waiting for job ${jobId}`);
              agent.stop().then(() => process.exit(4));
            }
          }, timeoutSec * 1000);
        }

        await agent.start();

        process.stderr.write(`Watching job ${jobId}...\n`);

        const shutdown = async () => {
          if (!settled) {
            settled = true;
            await agent.stop();
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
