import * as readline from "readline";
import type { Command } from "commander";
import { isJson, outputResult, outputError, isTTY } from "../lib/output";
import { c } from "../lib/color";
import type {
  AgentSubscription,
  CreateSubscriptionBody,
  UpdateSubscriptionBody,
} from "../lib/api/agent";
import { getClient } from "../lib/api/client";
import { prompt, selectOption, printTable } from "../lib/prompt";
import { getActiveAgentId } from "../lib/activeAgent";

const SECONDS_PER_DAY = 86400;
const ALLOWED_DURATION_DAYS = [7, 15, 30, 90] as const;
const ALLOWED_DURATION_HINT = ALLOWED_DURATION_DAYS.join(", ");
const DURATION_ERROR = `Duration must be one of: ${ALLOWED_DURATION_HINT} days.`;

function daysToSeconds(days: number): number {
  return Math.round(days * SECONDS_PER_DAY);
}

function secondsToDays(seconds: number): number {
  return seconds / SECONDS_PER_DAY;
}

function parsePositiveFloat(value: string): number | null {
  const n = parseFloat(value);
  if (isNaN(n) || n <= 0) return null;
  return n;
}

function parseAllowedDurationDays(value: string): number | null {
  const n = parseFloat(value);
  if (isNaN(n)) return null;
  return (ALLOWED_DURATION_DAYS as readonly number[]).includes(n) ? n : null;
}

function printSubscription(s: AgentSubscription): void {
  printTable([
    ["ID", s.id],
    ["Package ID", String(s.packageId)],
    ["Name", s.name],
    ["Price", `${s.price} USDC`],
    ["Duration", `${secondsToDays(s.duration)} days`],
  ]);
}

export function registerSubscriptionCommands(program: Command): void {
  const subscription = program
    .command("subscription")
    .description("Manage agent subscriptions");

  // LIST
  subscription
    .command("list")
    .description("List subscriptions for the active agent")
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const agent = await agentApi.getById(agentId);
        const subscriptions = agent.subscriptions ?? [];

        if (json) {
          process.stdout.write(JSON.stringify(subscriptions) + "\n");
          return;
        }

        if (subscriptions.length === 0) {
          console.log("No subscriptions found.");
          return;
        }

        if (isTTY()) {
          for (const s of subscriptions) {
            printSubscription(s);
            console.log();
          }
        } else {
          console.log("ID\tPACKAGE_ID\tNAME\tPRICE\tDURATION_DAYS");
          for (const s of subscriptions) {
            console.log(
              `${s.id}\t${s.packageId}\t${s.name}\t${
                s.price
              } USDC\t${secondsToDays(s.duration)}`
            );
          }
        }
      } catch (err) {
        outputError(
          json,
          `Failed to list subscriptions: ${
            err instanceof Error ? err : String(err)
          }`
        );
      }
    });

  // CREATE
  subscription
    .command("create")
    .description("Create a new subscription for the active agent")
    .option("--name <name>", "Subscription name")
    .option("--price <usdc>", "Price in USDC")
    .option(
      "--duration-days <days>",
      `Duration in days (allowed: ${ALLOWED_DURATION_HINT})`
    )
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      const needsPrompt = !opts.name || !opts.price || !opts.durationDays;

      let rl: readline.Interface | undefined;

      try {
        if (needsPrompt) {
          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
        }

        let name: string;
        if (opts.name) {
          name = opts.name.trim();
          if (!name) {
            outputError(json, "Name cannot be empty.");
            return;
          }
        } else {
          name = (await prompt(rl!, "Subscription name: ")).trim();
          if (!name) {
            outputError(json, "Name cannot be empty.");
            return;
          }
        }

        let price: number;
        if (opts.price) {
          const parsed = parsePositiveFloat(opts.price);
          if (parsed === null) {
            outputError(json, "Price must be a positive number.");
            return;
          }
          price = parsed;
        } else {
          const priceStr = (await prompt(rl!, "Price (USDC): ")).trim();
          const parsed = parsePositiveFloat(priceStr);
          if (parsed === null) {
            outputError(json, "Price must be a positive number.");
            return;
          }
          price = parsed;
        }

        let durationDays: number;
        if (opts.durationDays) {
          const parsed = parseAllowedDurationDays(opts.durationDays);
          if (parsed === null) {
            outputError(json, DURATION_ERROR);
            return;
          }
          durationDays = parsed;
        } else {
          const durationStr = (
            await prompt(rl!, `Duration days (${ALLOWED_DURATION_HINT}): `)
          ).trim();
          const parsed = parseAllowedDurationDays(durationStr);
          if (parsed === null) {
            outputError(json, DURATION_ERROR);
            return;
          }
          durationDays = parsed;
        }

        const body: CreateSubscriptionBody = {
          name,
          price,
          duration: daysToSeconds(durationDays),
        };

        const created = await agentApi.createSubscription(agentId, body);

        if (json) {
          outputResult(json, created as unknown as Record<string, unknown>);
          return;
        }

        console.log(`\n${c.green("Subscription created successfully!")}\n`);
        printSubscription(created);
      } catch (err) {
        outputError(
          json,
          `Failed to create subscription: ${
            err instanceof Error ? err : String(err)
          }`
        );
      } finally {
        rl?.close();
      }
    });

  // UPDATE
  subscription
    .command("update")
    .description("Update an existing subscription for the active agent")
    .option("--id <uuid>", "Subscription UUID to update")
    .option("--name <name>", "New name")
    .option("--price <usdc>", "New price in USDC")
    .option(
      "--duration-days <days>",
      `New duration in days (allowed: ${ALLOWED_DURATION_HINT})`
    )
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      let subscriptions: AgentSubscription[];
      try {
        const agent = await agentApi.getById(agentId);
        subscriptions = agent.subscriptions ?? [];
      } catch (err) {
        outputError(
          json,
          `Failed to fetch subscriptions: ${
            err instanceof Error ? err : String(err)
          }`
        );
        return;
      }

      if (subscriptions.length === 0) {
        outputError(json, "No subscriptions found to update.");
        return;
      }

      let selected: AgentSubscription;
      if (opts.id) {
        const match = subscriptions.find((s) => s.id === opts.id);
        if (!match) {
          outputError(json, `No subscription found with ID: ${opts.id}`);
          return;
        }
        selected = match;
      } else {
        selected = await selectOption(
          "Choose a subscription to update:",
          subscriptions,
          (s) =>
            `${s.name} — ${s.price} USDC / ${secondsToDays(s.duration)} days`
        );
      }

      // If --id is provided, build updates from flags only (non-interactive)
      const nonInteractive = !!opts.id;

      let rl: readline.Interface | undefined;

      try {
        if (!nonInteractive) {
          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          console.log("\nPress Enter to keep current value.\n");
        }

        const updates: UpdateSubscriptionBody = {};

        if (opts.name) {
          updates.name = opts.name.trim();
        } else if (!nonInteractive) {
          const name = (await prompt(rl!, `Name [${selected.name}]: `)).trim();
          if (name) updates.name = name;
        }

        if (opts.price) {
          const parsed = parsePositiveFloat(opts.price);
          if (parsed === null) {
            outputError(json, "Price must be a positive number.");
            return;
          }
          updates.price = parsed;
        } else if (!nonInteractive) {
          const priceStr = (
            await prompt(rl!, `Price USDC [${selected.price}]: `)
          ).trim();
          if (priceStr) {
            const parsed = parsePositiveFloat(priceStr);
            if (parsed === null) {
              outputError(json, "Price must be a positive number.");
              return;
            }
            updates.price = parsed;
          }
        }

        if (opts.durationDays) {
          const parsed = parseAllowedDurationDays(opts.durationDays);
          if (parsed === null) {
            outputError(json, DURATION_ERROR);
            return;
          }
          updates.duration = daysToSeconds(parsed);
        } else if (!nonInteractive) {
          const durationStr = (
            await prompt(
              rl!,
              `Duration days [${secondsToDays(
                selected.duration
              )}] (${ALLOWED_DURATION_HINT}): `
            )
          ).trim();
          if (durationStr) {
            const parsed = parseAllowedDurationDays(durationStr);
            if (parsed === null) {
              outputError(json, DURATION_ERROR);
              return;
            }
            updates.duration = daysToSeconds(parsed);
          }
        }

        if (Object.keys(updates).length === 0) {
          console.log("No changes made.");
          return;
        }

        const updated = await agentApi.updateSubscription(
          agentId,
          selected.id,
          updates
        );

        if (json) {
          outputResult(json, updated as unknown as Record<string, unknown>);
          return;
        }

        console.log(`\n${c.green("Subscription updated successfully!")}\n`);
        printSubscription(updated);
      } catch (err) {
        outputError(
          json,
          `Failed to update subscription: ${
            err instanceof Error ? err : String(err)
          }`
        );
      } finally {
        rl?.close();
      }
    });

  // DELETE
  subscription
    .command("delete")
    .description("Delete a subscription from the active agent")
    .option("--id <uuid>", "Subscription UUID to delete")
    .option("--force", "Skip confirmation prompt")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      let subscriptions: AgentSubscription[];
      try {
        const agent = await agentApi.getById(agentId);
        subscriptions = agent.subscriptions ?? [];
      } catch (err) {
        outputError(
          json,
          `Failed to fetch subscriptions: ${
            err instanceof Error ? err : String(err)
          }`
        );
        return;
      }

      if (subscriptions.length === 0) {
        outputError(json, "No subscriptions found to delete.");
        return;
      }

      let selected: AgentSubscription;
      if (opts.id) {
        const match = subscriptions.find((s) => s.id === opts.id);
        if (!match) {
          outputError(json, `No subscription found with ID: ${opts.id}`);
          return;
        }
        selected = match;
      } else {
        selected = await selectOption(
          "Choose a subscription to delete:",
          subscriptions,
          (s) =>
            `${s.name} — ${s.price} USDC / ${secondsToDays(s.duration)} days`
        );
      }

      if (!opts.force) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        try {
          const confirm = (
            await prompt(rl, `Delete subscription '${selected.name}'? (y/N): `)
          )
            .trim()
            .toLowerCase();

          if (confirm !== "y") {
            console.log("Cancelled.");
            return;
          }
        } finally {
          rl.close();
        }
      }

      try {
        await agentApi.deleteSubscription(agentId, selected.id);

        if (json) {
          outputResult(json, {
            success: true,
            deletedSubscription: selected.name,
          });
        } else {
          console.log(
            `\n${c.green(
              `Subscription '${selected.name}' deleted successfully.`
            )}`
          );
        }
      } catch (err) {
        outputError(
          json,
          `Failed to delete subscription: ${
            err instanceof Error ? err : String(err)
          }`
        );
      }
    });
}
