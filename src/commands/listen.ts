import type { Command } from "commander";
import type { JobSession, JobRoomEntry } from "acp-node-v2";
import { createAgentFromEnv } from "../lib/agentFactory.js";

export function registerListenCommand(program: Command): void {
  program
    .command("listen")
    .description(
      "Stream job events as JSON lines (long-running background process). " +
        "Each line is self-contained with full session context."
    )
    .option("--job-id <id>", "Filter events to a specific job ID")
    .action(async (opts) => {
      try {
        const agent = await createAgentFromEnv();

        agent.on("entry", (session: JobSession, entry: JobRoomEntry) => {
          if (opts.jobId && session.jobId !== opts.jobId) return;

          const line = JSON.stringify({
            jobId: session.jobId,
            chainId: session.chainId,
            status: session.status,
            roles: session.roles,
            availableTools: session.availableTools().map((t) => t.name),
            context: session.toContext(),
            entry,
          });
          process.stdout.write(line + "\n");
        });

        await agent.start();

        const shutdown = async () => {
          await agent.stop();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(JSON.stringify({ error: msg }) + "\n");
        process.exit(1);
      }
    });
}
