import * as readline from "readline";
import Ajv from "ajv";
import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output";
import type {
  AgentOffering,
  CreateOfferingBody,
  UpdateOfferingBody,
} from "../lib/api/agent";
import { getClient } from "../lib/api/client";
import { prompt, selectOption, printTable } from "../lib/prompt";
import { getActiveWallet, getAgentId } from "../lib/config";

function getActiveAgentId(json: boolean): string | null {
  const activeWallet = getActiveWallet();
  if (!activeWallet) {
    outputError(json, "No active agent set. Run `acp agent use` first.");
    return null;
  }
  const agentId = getAgentId(activeWallet);
  if (!agentId) {
    outputError(
      json,
      "Agent ID not found for active wallet. Run `acp agent list` or `acp agent use` to populate it."
    );
    return null;
  }
  return agentId;
}

function validateJsonSchema(input: string): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Invalid JSON. Please provide valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JSON schema must be an object.");
  }
  try {
    const ajv = new Ajv({ allErrors: true });
    ajv.compile(parsed);
  } catch (err) {
    throw new Error(
      `Invalid JSON schema: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return parsed;
}

function parseSchemaOrString(
  value: string,
  fieldName: string
): Record<string, unknown> | string {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return validateJsonSchema(value);
    }
  } catch {
    // Not valid JSON — treat as string description
  }
  if (!value.trim()) {
    throw new Error(`${fieldName} cannot be empty.`);
  }
  return value;
}

async function promptSchemaField(
  rl: readline.Interface,
  fieldName: string
): Promise<Record<string, unknown> | string> {
  const type = (
    await prompt(
      rl,
      `${fieldName} type (1: string description, 2: JSON schema) [1]: `
    )
  ).trim();

  if (type === "2") {
    const input = (
      await prompt(rl, `${fieldName} (JSON schema): `)
    ).trim();
    return validateJsonSchema(input);
  }

  const value = (
    await prompt(rl, `${fieldName} (description): `)
  ).trim();
  if (!value) throw new Error(`${fieldName} cannot be empty.`);
  return value;
}

function printOffering(offering: AgentOffering): void {
  const reqDisplay =
    typeof offering.requirements === "object"
      ? JSON.stringify(offering.requirements)
      : offering.requirements;
  const delDisplay =
    typeof offering.deliverable === "object"
      ? JSON.stringify(offering.deliverable)
      : offering.deliverable;

  printTable([
    ["ID", offering.id],
    ["Name", offering.name],
    ["Description", offering.description],
    ["Requirements", reqDisplay],
    ["Deliverable", delDisplay],
    ["Price", `${offering.priceValue} (${offering.priceType})`],
    ["SLA", `${offering.slaMinutes} min`],
    ["Required Funds", offering.requiredFunds ? "Yes" : "No"],
    ["Hidden", offering.isHidden ? "Yes" : "No"],
    ["Private", offering.isPrivate ? "Yes" : "No"],
  ]);
}

export function registerOfferingCommands(program: Command): void {
  const offering = program
    .command("offering")
    .description("Manage agent offerings");

  // LIST
  offering
    .command("list")
    .description("List offerings for the active agent")
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const agent = await agentApi.getById(agentId);
        const offerings = agent.offerings ?? [];

        if (json) {
          process.stdout.write(JSON.stringify(offerings) + "\n");
          return;
        }

        if (offerings.length === 0) {
          console.log("No offerings found.");
          return;
        }

        for (const o of offerings) {
          printOffering(o);
          console.log();
        }
      } catch (err) {
        outputError(
          json,
          `Failed to list offerings: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    });

  // CREATE
  offering
    .command("create")
    .description("Create a new offering for the active agent")
    .option("--name <name>", "Offering name")
    .option("--description <text>", "Description")
    .option("--price-type <type>", "Price type: fixed or percentage")
    .option("--price-value <value>", "Price value")
    .option("--sla-minutes <minutes>", "SLA in minutes")
    .option("--requirements <value>", "Requirements (string or JSON schema)")
    .option("--deliverable <value>", "Deliverable (string or JSON schema)")
    .option("--required-funds", "Require funds")
    .option("--no-required-funds", "Do not require funds")
    .option("--hidden", "Hidden offering")
    .option("--no-hidden", "Visible offering")
    .option("--private", "Private offering")
    .option("--no-private", "Public offering")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      const needsPrompt =
        !opts.name ||
        !opts.description ||
        !opts.priceType ||
        !opts.priceValue ||
        !opts.slaMinutes ||
        !opts.requirements ||
        !opts.deliverable ||
        opts.requiredFunds === undefined ||
        opts.hidden === undefined ||
        opts.private === undefined;

      let rl: readline.Interface | undefined;

      try {
        if (needsPrompt) {
          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
        }

        // Name
        let name: string;
        if (opts.name) {
          name = opts.name.trim();
          if (!name) { outputError(json, "Name cannot be empty."); return; }
        } else {
          name = (await prompt(rl!, "Offering name (3-20 chars): ")).trim();
          if (!name) { outputError(json, "Name cannot be empty."); return; }
        }

        // Description
        let description: string;
        if (opts.description) {
          description = opts.description.trim();
          if (!description) { outputError(json, "Description cannot be empty."); return; }
        } else {
          description = (await prompt(rl!, "Description (10-500 chars): ")).trim();
          if (!description) { outputError(json, "Description cannot be empty."); return; }
        }

        // Price type
        let priceType: "fixed" | "percentage";
        if (opts.priceType) {
          const pt = opts.priceType.trim().toLowerCase();
          if (pt !== "fixed" && pt !== "percentage") {
            outputError(json, "Price type must be 'fixed' or 'percentage'.");
            return;
          }
          priceType = pt;
        } else {
          priceType = await selectOption(
            "Price type:",
            ["fixed", "percentage"] as const,
            (t) => t
          );
        }

        // Price value
        let priceValue: number;
        if (opts.priceValue) {
          priceValue = parseFloat(opts.priceValue);
          if (isNaN(priceValue) || priceValue <= 0) {
            outputError(json, "Price value must be a positive number.");
            return;
          }
        } else {
          const priceValueStr = (await prompt(rl!, "Price value: ")).trim();
          priceValue = parseFloat(priceValueStr);
          if (isNaN(priceValue) || priceValue <= 0) {
            outputError(json, "Price value must be a positive number.");
            return;
          }
        }

        // SLA minutes
        let slaMinutes: number;
        if (opts.slaMinutes) {
          slaMinutes = parseInt(opts.slaMinutes, 10);
          if (isNaN(slaMinutes) || slaMinutes < 5) {
            outputError(json, "SLA must be at least 5 minutes.");
            return;
          }
        } else {
          const slaStr = (await prompt(rl!, "SLA in minutes (min 5): ")).trim();
          slaMinutes = parseInt(slaStr, 10);
          if (isNaN(slaMinutes) || slaMinutes < 5) {
            outputError(json, "SLA must be at least 5 minutes.");
            return;
          }
        }

        // Requirements
        let requirements: Record<string, unknown> | string;
        if (opts.requirements) {
          try {
            requirements = parseSchemaOrString(opts.requirements, "Requirements");
          } catch (err) {
            outputError(json, err instanceof Error ? err.message : String(err));
            return;
          }
        } else {
          try {
            requirements = await promptSchemaField(rl!, "Requirements");
          } catch (err) {
            outputError(json, err instanceof Error ? err.message : String(err));
            return;
          }
        }

        // Deliverable
        let deliverable: Record<string, unknown> | string;
        if (opts.deliverable) {
          try {
            deliverable = parseSchemaOrString(opts.deliverable, "Deliverable");
          } catch (err) {
            outputError(json, err instanceof Error ? err.message : String(err));
            return;
          }
        } else {
          try {
            deliverable = await promptSchemaField(rl!, "Deliverable");
          } catch (err) {
            outputError(json, err instanceof Error ? err.message : String(err));
            return;
          }
        }

        // Booleans
        let requiredFunds: boolean;
        if (opts.requiredFunds !== undefined) {
          requiredFunds = opts.requiredFunds;
        } else {
          const requiredFundsStr = (
            await prompt(rl!, "Required funds? (y/N): ")
          ).trim().toLowerCase();
          requiredFunds = requiredFundsStr === "y";
        }

        let isHidden: boolean;
        if (opts.hidden !== undefined) {
          isHidden = opts.hidden;
        } else {
          const isHiddenStr = (
            await prompt(rl!, "Hidden? (y/N): ")
          ).trim().toLowerCase();
          isHidden = isHiddenStr === "y";
        }

        let isPrivate: boolean;
        if (opts.private !== undefined) {
          isPrivate = opts.private;
        } else {
          const isPrivateStr = (
            await prompt(rl!, "Private? (y/N): ")
          ).trim().toLowerCase();
          isPrivate = isPrivateStr === "y";
        }

        const body: CreateOfferingBody = {
          name,
          description,
          priceType,
          priceValue,
          slaMinutes,
          requirements,
          deliverable,
          requiredFunds,
          isHidden,
          isPrivate,
        };

        const created = await agentApi.createOffering(agentId, body);

        if (json) {
          outputResult(json, created as unknown as Record<string, unknown>);
          return;
        }

        console.log("\nOffering created successfully!\n");
        printOffering(created);
      } catch (err) {
        outputError(
          json,
          `Failed to create offering: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } finally {
        rl?.close();
      }
    });

  // UPDATE
  offering
    .command("update")
    .description("Update an existing offering for the active agent")
    .option("--offering-id <id>", "Offering ID to update")
    .option("--name <name>", "New name")
    .option("--description <text>", "New description")
    .option("--price-type <type>", "New price type: fixed or percentage")
    .option("--price-value <value>", "New price value")
    .option("--sla-minutes <minutes>", "New SLA in minutes")
    .option("--requirements <value>", "New requirements (string or JSON schema)")
    .option("--deliverable <value>", "New deliverable (string or JSON schema)")
    .option("--required-funds", "Set required funds to true")
    .option("--no-required-funds", "Set required funds to false")
    .option("--hidden", "Set hidden to true")
    .option("--no-hidden", "Set hidden to false")
    .option("--private", "Set private to true")
    .option("--no-private", "Set private to false")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      let offerings: AgentOffering[];
      try {
        const agent = await agentApi.getById(agentId);
        offerings = agent.offerings ?? [];
      } catch (err) {
        outputError(
          json,
          `Failed to fetch offerings: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      if (offerings.length === 0) {
        outputError(json, "No offerings found to update.");
        return;
      }

      let selected: AgentOffering;
      if (opts.offeringId) {
        const match = offerings.find((o) => o.id === opts.offeringId);
        if (!match) {
          outputError(json, `No offering found with ID: ${opts.offeringId}`);
          return;
        }
        selected = match;
      } else {
        selected = await selectOption(
          "Choose an offering to update:",
          offerings,
          (o) => `${o.name} — ${o.priceValue} (${o.priceType})`
        );
      }

      // If --offering-id is provided, build updates from flags only (non-interactive)
      const nonInteractive = !!opts.offeringId;

      let rl: readline.Interface | undefined;

      try {
        if (!nonInteractive) {
          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          console.log("\nPress Enter to keep current value.\n");
        }

        const updates: UpdateOfferingBody = {};

        // Name
        if (opts.name) {
          updates.name = opts.name.trim();
        } else if (!nonInteractive) {
          const name = (await prompt(rl!, `Name [${selected.name}]: `)).trim();
          if (name) updates.name = name;
        }

        // Description
        if (opts.description) {
          updates.description = opts.description.trim();
        } else if (!nonInteractive) {
          const description = (
            await prompt(rl!, `Description [${selected.description}]: `)
          ).trim();
          if (description) updates.description = description;
        }

        // Price value
        if (opts.priceValue) {
          const pv = parseFloat(opts.priceValue);
          if (isNaN(pv) || pv <= 0) {
            outputError(json, "Price value must be a positive number.");
            return;
          }
          updates.priceValue = pv;
        } else if (!nonInteractive) {
          const priceValueStr = (
            await prompt(rl!, `Price value [${selected.priceValue}]: `)
          ).trim();
          if (priceValueStr) {
            const pv = parseFloat(priceValueStr);
            if (isNaN(pv) || pv <= 0) {
              outputError(json, "Price value must be a positive number.");
              return;
            }
            updates.priceValue = pv;
          }
        }

        // Price type
        if (opts.priceType) {
          const pt = opts.priceType.trim().toLowerCase();
          if (pt !== "fixed" && pt !== "percentage") {
            outputError(json, "Price type must be 'fixed' or 'percentage'.");
            return;
          }
          updates.priceType = pt;
        } else if (!nonInteractive) {
          const priceTypeStr = (
            await prompt(rl!, `Price type [${selected.priceType}] (fixed/percentage): `)
          ).trim().toLowerCase();
          if (priceTypeStr) {
            if (priceTypeStr !== "fixed" && priceTypeStr !== "percentage") {
              outputError(json, "Price type must be 'fixed' or 'percentage'.");
              return;
            }
            updates.priceType = priceTypeStr;
          }
        }

        // SLA minutes
        if (opts.slaMinutes) {
          const sla = parseInt(opts.slaMinutes, 10);
          if (isNaN(sla) || sla < 5) {
            outputError(json, "SLA must be at least 5 minutes.");
            return;
          }
          updates.slaMinutes = sla;
        } else if (!nonInteractive) {
          const slaStr = (
            await prompt(rl!, `SLA minutes [${selected.slaMinutes}]: `)
          ).trim();
          if (slaStr) {
            const sla = parseInt(slaStr, 10);
            if (isNaN(sla) || sla < 5) {
              outputError(json, "SLA must be at least 5 minutes.");
              return;
            }
            updates.slaMinutes = sla;
          }
        }

        // Requirements
        if (opts.requirements) {
          try {
            updates.requirements = parseSchemaOrString(opts.requirements, "Requirements");
          } catch (err) {
            outputError(json, err instanceof Error ? err.message : String(err));
            return;
          }
        } else if (!nonInteractive) {
          const currentReqDisplay =
            typeof selected.requirements === "object"
              ? JSON.stringify(selected.requirements)
              : selected.requirements;
          const updateReq = (
            await prompt(
              rl!,
              `Update requirements? Current: ${currentReqDisplay} (y/N): `
            )
          ).trim().toLowerCase();
          if (updateReq === "y") {
            try {
              updates.requirements = await promptSchemaField(rl!, "Requirements");
            } catch (err) {
              outputError(json, err instanceof Error ? err.message : String(err));
              return;
            }
          }
        }

        // Deliverable
        if (opts.deliverable) {
          try {
            updates.deliverable = parseSchemaOrString(opts.deliverable, "Deliverable");
          } catch (err) {
            outputError(json, err instanceof Error ? err.message : String(err));
            return;
          }
        } else if (!nonInteractive) {
          const currentDelDisplay =
            typeof selected.deliverable === "object"
              ? JSON.stringify(selected.deliverable)
              : selected.deliverable;
          const updateDel = (
            await prompt(
              rl!,
              `Update deliverable? Current: ${currentDelDisplay} (y/N): `
            )
          ).trim().toLowerCase();
          if (updateDel === "y") {
            try {
              updates.deliverable = await promptSchemaField(rl!, "Deliverable");
            } catch (err) {
              outputError(json, err instanceof Error ? err.message : String(err));
              return;
            }
          }
        }

        // Required funds
        if (opts.requiredFunds !== undefined) {
          updates.requiredFunds = opts.requiredFunds;
        } else if (!nonInteractive) {
          const reqFundsStr = (
            await prompt(
              rl!,
              `Required funds [${selected.requiredFunds ? "Yes" : "No"}] (y/n): `
            )
          ).trim().toLowerCase();
          if (reqFundsStr === "y") updates.requiredFunds = true;
          else if (reqFundsStr === "n") updates.requiredFunds = false;
        }

        // Hidden
        if (opts.hidden !== undefined) {
          updates.isHidden = opts.hidden;
        } else if (!nonInteractive) {
          const hiddenStr = (
            await prompt(
              rl!,
              `Hidden [${selected.isHidden ? "Yes" : "No"}] (y/n): `
            )
          ).trim().toLowerCase();
          if (hiddenStr === "y") updates.isHidden = true;
          else if (hiddenStr === "n") updates.isHidden = false;
        }

        // Private
        if (opts.private !== undefined) {
          updates.isPrivate = opts.private;
        } else if (!nonInteractive) {
          const privateStr = (
            await prompt(
              rl!,
              `Private [${selected.isPrivate ? "Yes" : "No"}] (y/n): `
            )
          ).trim().toLowerCase();
          if (privateStr === "y") updates.isPrivate = true;
          else if (privateStr === "n") updates.isPrivate = false;
        }

        if (Object.keys(updates).length === 0) {
          console.log("No changes made.");
          return;
        }

        const updated = await agentApi.updateOffering(
          agentId,
          selected.id,
          updates
        );

        if (json) {
          outputResult(json, updated as unknown as Record<string, unknown>);
          return;
        }

        console.log("\nOffering updated successfully!\n");
        printOffering(updated);
      } catch (err) {
        outputError(
          json,
          `Failed to update offering: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } finally {
        rl?.close();
      }
    });

  // DELETE
  offering
    .command("delete")
    .description("Delete an offering from the active agent")
    .option("--offering-id <id>", "Offering ID to delete")
    .option("--force", "Skip confirmation prompt")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      let offerings: AgentOffering[];
      try {
        const agent = await agentApi.getById(agentId);
        offerings = agent.offerings ?? [];
      } catch (err) {
        outputError(
          json,
          `Failed to fetch offerings: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      if (offerings.length === 0) {
        outputError(json, "No offerings found to delete.");
        return;
      }

      let selected: AgentOffering;
      if (opts.offeringId) {
        const match = offerings.find((o) => o.id === opts.offeringId);
        if (!match) {
          outputError(json, `No offering found with ID: ${opts.offeringId}`);
          return;
        }
        selected = match;
      } else {
        selected = await selectOption(
          "Choose an offering to delete:",
          offerings,
          (o) => `${o.name} — ${o.priceValue} (${o.priceType})`
        );
      }

      if (!opts.force) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        try {
          const confirm = (
            await prompt(rl, `Delete offering '${selected.name}'? (y/N): `)
          ).trim().toLowerCase();

          if (confirm !== "y") {
            console.log("Cancelled.");
            return;
          }
        } finally {
          rl.close();
        }
      }

      try {
        await agentApi.deleteOffering(agentId, selected.id);

        if (json) {
          outputResult(json, {
            success: true,
            deletedOffering: selected.name,
          });
        } else {
          console.log(`\nOffering '${selected.name}' deleted successfully.`);
        }
      } catch (err) {
        outputError(
          json,
          `Failed to delete offering: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    });
}
