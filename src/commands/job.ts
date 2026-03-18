import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output.js";
import { getWalletAddress, getSocketUrl } from "../lib/agentFactory.js";
import { getActiveJobs, getJobHistory } from "../lib/rest.js";

export function registerJobCommands(program: Command): void {
  const job = program
    .command("job")
    .description("Job queries (status, list)");

  job
    .command("list")
    .description("List active jobs (REST, no socket connection needed)")
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);
      try {
        const wallet = getWalletAddress();
        const serverUrl = getSocketUrl();
        const jobs = await getActiveJobs(serverUrl, wallet);

        if (json) {
          outputResult(true, { jobs });
        } else {
          if (jobs.length === 0) {
            console.log("No active jobs.");
          } else {
            console.log(`Active jobs (${jobs.length}):\n`);
            for (const j of jobs) {
              console.log(`  Job ${j.onChainJobId}  (chain ${j.chainId})`);
            }
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
      }
    });

  job
    .command("status")
    .description("Get job status and message history (REST, no socket connection needed)")
    .requiredOption("--job-id <id>", "On-chain job ID")
    .option("--chain-id <id>", "Chain ID", "84532")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const wallet = getWalletAddress();
        const serverUrl = getSocketUrl();
        const entries = await getJobHistory(
          serverUrl,
          wallet,
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
        } else {
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
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err.message : String(err));
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
