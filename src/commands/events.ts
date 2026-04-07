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
import {
  createAgentFromConfig,
  createLegacyBuyerAdapter,
  getWalletAddress,
} from "../lib/agentFactory";
import { isJson, outputResult, outputError, maskAddress, isTTY } from "../lib/output";
import { LegacyBuyerAdapter } from "../lib/compat/legacyBuyerAdapter";
import { AcpJobPhases, AcpJob, AcpMemo } from "@virtuals-protocol/acp-node";
import { FundIntent } from "acp-node-v2/dist/events/types";
import { CliError } from "../lib/errors";
import { c } from "../lib/color";

function formatEventDetails(event: Record<string, unknown>): string {
  const parts: string[] = [];
  if (event.amount !== undefined) parts.push(`amount=${event.amount} USDC`);
  if (event.deliverable !== undefined) {
    const del = String(event.deliverable);
    parts.push(`deliverable="${del.length > 40 ? del.slice(0, 37) + "..." : del}"`);
  }
  if (event.fundRequest) {
    const fr = event.fundRequest as Record<string, unknown>;
    parts.push(`transfer=${fr.amount} ${fr.symbol ?? "USDC"}`);
  }
  return parts.join("  ");
}

function phaseToEventType(phase: AcpJobPhases): string {
  switch (phase) {
    case AcpJobPhases.NEGOTIATION:
      return "budget.set";
    case AcpJobPhases.TRANSACTION:
      return "job.funded";
    case AcpJobPhases.EVALUATION:
      return "job.submitted";
    case AcpJobPhases.COMPLETED:
      return "job.completed";
    case AcpJobPhases.REJECTED:
      return "job.rejected";
    case AcpJobPhases.EXPIRED:
      return "job.expired";
    default:
      return "job.created";
  }
}

function v1AvailableTools(phase: AcpJobPhases): string[] {
  switch (phase) {
    case AcpJobPhases.NEGOTIATION:
      return ["fund"];
    case AcpJobPhases.EVALUATION:
      return ["complete", "reject"];
    default:
      return [];
  }
}

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
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const agent = await createAgentFromConfig();

        const writeJson = opts.output
          ? (line: string) => appendFileSync(opts.output, line + "\n")
          : (line: string) => process.stdout.write(line + "\n");

        const humanMode = !json && !opts.output && isTTY();

        const allowedEvents: Set<string> | undefined = opts.events
          ? new Set(opts.events.split(",").map((s: string) => s.trim()))
          : undefined;


        agent.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
          if (opts.jobId && session.jobId !== opts.jobId) return;

          const entryAny = entry as Record<string, unknown>;
          const event = entryAny.event as Record<string, unknown> | undefined;
          const eventType = event?.type as string | undefined;

          if (allowedEvents) {
            if (!eventType || !allowedEvents.has(eventType)) return;
          }

          const data = {
            jobId: session.jobId,
            chainId: session.chainId,
            status: session.status,
            legacy: false,
            roles: session.roles,
            availableTools: session.availableTools().map((t: { name: string }) => t.name),
            entry,
          };

          if (humanMode) {
            const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
            const tools = data.availableTools.filter((t: string) => t !== "wait");

            if (eventType) {
              const details = formatEventDetails(event!);
              const toolStr = tools.length > 0 ? c.dim(`  [${tools.join(", ")}]`) : "";
              process.stdout.write(
                `${c.dim(time)}  ${c.bold(`Job #${data.jobId}`)}  ${c.status(data.status)}  ${c.cyan(eventType)}  ${details}${toolStr}\n`
              );
            } else {
              const content = (entryAny.content as string) ?? "";
              const from = (entryAny.from as string) ?? "unknown";
              const truncated = content.length > 80 ? content.slice(0, 77) + "..." : content;
              process.stdout.write(
                `${c.dim(time)}  ${c.bold(`Job #${data.jobId}`)}  ${c.dim(`[${maskAddress(from)}]`)} ${truncated}\n`
              );
            }
          } else {
            writeJson(JSON.stringify(data));
          }
        });

        await agent.start();

        try {
          const legacyAdapter = await createLegacyBuyerAdapter(undefined, {
            onNewTask: async (job: AcpJob, memoToSign?: AcpMemo) => {
              const jobId = String(job.id);
              if (opts.jobId && jobId !== opts.jobId) return;

              const status = LegacyBuyerAdapter.phaseToStatus(job.phase);
              const eventType = phaseToEventType(job.phase);

              const deliverable = await job.getDeliverable();
              const budget = job.price;

              let fundRequest: FundIntent | null = null;

              if (
                memoToSign &&
                memoToSign.payableDetails &&
                job.phase === AcpJobPhases.NEGOTIATION
              ) {
                const requestToken = await agent.resolveRawAssetToken(
                  memoToSign.payableDetails.token,
                  memoToSign.payableDetails.amount,
                  legacyAdapter.chainId
                );

                fundRequest = {
                  amount: requestToken.amount,
                  tokenAddress: requestToken.address,
                  symbol: requestToken.symbol,
                  recipient: memoToSign.payableDetails.recipient,
                };
              }

              const completedMemo = job.memos.find(
                (m) => m.nextPhase === AcpJobPhases.COMPLETED
              );
              let fundTransfer: FundIntent | null = null;

              if (completedMemo && completedMemo.payableDetails) {
                const transferToken = await agent.resolveRawAssetToken(
                  completedMemo.payableDetails.token,
                  completedMemo.payableDetails.amount,
                  legacyAdapter.chainId
                );

                fundTransfer = {
                  amount: transferToken.amount,
                  tokenAddress: transferToken.address,
                  symbol: transferToken.symbol,
                  recipient: completedMemo.payableDetails.recipient,
                };
              }

              const line = JSON.stringify({
                jobId,
                chainId: legacyAdapter.chainId,
                status,
                legacy: true,
                roles: ["client"],
                availableTools: v1AvailableTools(job.phase),
                entry: {
                  kind: "system",
                  onChainJobId: jobId,
                  chainId: legacyAdapter.chainId,
                  event: {
                    type: eventType,
                    jobId,
                    budget,
                    ...(fundTransfer ? { fundTransfer } : {}),
                    ...(fundRequest ? { fundRequest } : {}),
                    ...(deliverable ? { deliverable } : {}),
                  },
                  timestamp: Date.now(),
                },
              });
              writeJson(line);
            },
          });
        } catch (err) {
          process.stderr.write(
            JSON.stringify({
              warning: `Legacy listener failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            }) + "\n"
          );
        }

        const wallet = getWalletAddress();
        process.stderr.write(`${c.green("Listening for events... connected.")}\n`);
        process.stderr.write(`Agent: ${maskAddress(wallet)}\n`);
        if (opts.output) {
          process.stderr.write(`Writing to: ${opts.output}\n`);
        }
        if (allowedEvents) {
          process.stderr.write(`Filtering: ${[...allowedEvents].join(", ")}\n`);
        }
        if (humanMode) {
          process.stderr.write(`Output: ${c.cyan("human-readable")} (use --json for NDJSON)\n`);
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
