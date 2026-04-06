import type { Command } from "commander";
import type { JobSession, JobRoomEntry } from "acp-node-v2";
import {
  appendFileSync,
  renameSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "fs";
import { createAgentFromConfig, getWalletAddress } from "../lib/agentFactory";
import { isJson, outputResult, outputError } from "../lib/output";
import { maskAddress } from "../lib/output";
import { CliError } from "../lib/errors";

export function registerEventsCommand(program: Command): void {
  const events = program
    .command("events")
    .description("Event streaming and processing");

  events
    .command("listen")
    .description(
      "Stream job events as JSON lines (long-running background process). " +
        "Each line is a lightweight event. Use `acp job status` for full context."
    )
    .option("--job-id <id>", "Filter events to a specific job ID")
    .option("--events <types>", "Comma-separated event types to include (e.g. job.created,budget.set,job.funded)")
    .option("--output <path>", "Append events to a file instead of stdout")
    .action(async (opts) => {
      try {
        const agent = await createAgentFromConfig();

        const write = opts.output
          ? (line: string) => appendFileSync(opts.output, line + "\n")
          : (line: string) => process.stdout.write(line + "\n");

        const allowedEvents: Set<string> | undefined = opts.events
          ? new Set(opts.events.split(",").map((s: string) => s.trim()))
          : undefined;

        agent.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
          if (opts.jobId && session.jobId !== opts.jobId) return;

          if (allowedEvents) {
            const entryAny = entry as Record<string, unknown>;
            const event = entryAny.event as Record<string, unknown> | undefined;
            const eventType = event?.type as string | undefined;
            if (!eventType || !allowedEvents.has(eventType)) return;
          }

          const line = JSON.stringify({
            jobId: session.jobId,
            chainId: session.chainId,
            status: session.status,
            roles: session.roles,
            availableTools: session.availableTools().map((t) => t.name),
            entry,
          });
          write(line);
        });

        await agent.start();

        const wallet = getWalletAddress();
        process.stderr.write(`Listening for events... connected.\n`);
        process.stderr.write(`Agent: ${maskAddress(wallet)}\n`);
        if (opts.output) {
          process.stderr.write(`Writing to: ${opts.output}\n`);
        }
        if (allowedEvents) {
          process.stderr.write(`Filtering: ${[...allowedEvents].join(", ")}\n`);
        }

        const shutdown = async () => {
          await agent.stop();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const payload: Record<string, string> = { error: msg };
        if (err instanceof CliError) {
          payload.code = err.code;
          if (err.recovery) payload.recovery = err.recovery;
        }
        process.stderr.write(JSON.stringify(payload) + "\n");
        process.exit(1);
      }
    });

  events
    .command("drain")
    .description(
      "Read and remove events from a listen output file. " +
        "Returns up to --limit events and removes them from the file."
    )
    .requiredOption("--file <path>", "Path to the listen output file")
    .option("--limit <n>", "Max number of events to drain", parseInt)
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const file: string = opts.file;
        const limit: number | undefined = opts.limit;

        if (!existsSync(file)) {
          outputResult(json, { events: [], remaining: 0 });
          return;
        }

        // Atomically take ownership of the file
        const lockFile = file + ".lock";
        renameSync(file, lockFile);

        let lines: string[];
        try {
          const content = readFileSync(lockFile, "utf-8").trim();
          lines = content ? content.split("\n") : [];
        } catch {
          lines = [];
        }

        const takeCount =
          limit !== undefined && limit > 0
            ? Math.min(limit, lines.length)
            : lines.length;
        const taken = lines.slice(0, takeCount);
        const remaining = lines.slice(takeCount);

        // Write remaining events back to original path, then remove lock file
        writeFileSync(
          file,
          remaining.length > 0 ? remaining.join("\n") + "\n" : ""
        );
        try {
          unlinkSync(lockFile);
        } catch {
          // already gone
        }

        const events = taken
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        outputResult(json, { events, remaining: remaining.length });
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
