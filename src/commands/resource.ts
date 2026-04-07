import * as readline from "readline";
import type { Command } from "commander";
import { isJson, outputResult, outputError, isTTY } from "../lib/output";
import { CliError } from "../lib/errors";
import { c } from "../lib/color";
import type {  AgentResource,
  CreateResourceBody,
  UpdateResourceBody,
} from "../lib/api/agent";
import { getClient } from "../lib/api/client";
import { prompt, selectOption, printTable } from "../lib/prompt";
import { getActiveWallet, getAgentId } from "../lib/config";
import { validateJsonSchema } from "../lib/validation";

function getActiveAgentId(json: boolean): string | null {
  const activeWallet = getActiveWallet();
  if (!activeWallet) {
    outputError(json, new CliError(
      "No active agent set.",
      "NO_ACTIVE_AGENT",
      "Run `acp agent use` to set an active agent."
    ));
    return null;
  }
  const agentId = getAgentId(activeWallet);
  if (!agentId) {
    outputError(json, new CliError(
      "Agent ID not found for active wallet.",
      "NO_ACTIVE_AGENT",
      "Run `acp agent list` or `acp agent use` to populate it."
    ));
    return null;
  }
  return agentId;
}

function printResource(resource: AgentResource): void {
  printTable([
    ["ID", resource.id],
    ["Name", resource.name],
    ["Description", resource.description],
    ["URL", resource.url],
    ["Params", JSON.stringify(resource.params)],
    ["Hidden", resource.isHidden ? "Yes" : "No"],
  ]);
}

export function registerResourceCommands(program: Command): void {
  const resource = program
    .command("resource")
    .description("Manage agent resources");

  // LIST
  resource
    .command("list")
    .description("List resources for the active agent")
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const agent = await agentApi.getById(agentId);
        const resources = agent.resources ?? [];

        if (json) {
          process.stdout.write(JSON.stringify(resources) + "\n");
          return;
        }

        if (resources.length === 0) {
          console.log("No resources found.");
          return;
        }

        if (isTTY()) {
          for (const r of resources) {
            printResource(r);
            console.log();
          }
        } else {
          console.log("ID\tNAME\tURL\tHIDDEN");
          for (const r of resources) {
            console.log(`${r.id}\t${r.name}\t${r.url}\t${r.isHidden ? "yes" : "no"}`);
          }
        }
      } catch (err) {
        outputError(
          json,
          `Failed to list resources: ${
            err instanceof Error ? err : String(err)
          }`
        );
      }
    });

  // CREATE
  resource
    .command("create")
    .description("Create a new resource for the active agent")
    .option("--name <name>", "Resource name")
    .option("--description <text>", "Description")
    .option("--url <url>", "Resource URL")
    .option("--params <json>", "Params JSON schema")
    .option("--hidden", "Hidden resource")
    .option("--no-hidden", "Visible resource")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      const needsPrompt =
        !opts.name ||
        !opts.description ||
        !opts.url ||
        !opts.params ||
        opts.hidden === undefined;

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
          name = (await prompt(rl!, "Resource name (1-100 chars): ")).trim();
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

        // URL
        let url: string;
        if (opts.url) {
          url = opts.url.trim();
          if (!url) { outputError(json, "URL cannot be empty."); return; }
        } else {
          url = (await prompt(rl!, "Resource URL: ")).trim();
          if (!url) { outputError(json, "URL cannot be empty."); return; }
        }

        // Params (JSON schema)
        let params: Record<string, unknown>;
        if (opts.params) {
          try {
            params = validateJsonSchema(opts.params);
          } catch (err) {
            outputError(json, err instanceof Error ? err : String(err));
            return;
          }
        } else {
          const paramsStr = (
            await prompt(rl!, "Params JSON schema (or {} for empty): ")
          ).trim();
          if (!paramsStr) {
            outputError(json, "Params cannot be empty. Use {} for no params.");
            return;
          }
          try {
            params = validateJsonSchema(paramsStr);
          } catch (err) {
            outputError(json, err instanceof Error ? err : String(err));
            return;
          }
        }

        // Hidden
        let hidden: boolean;
        if (opts.hidden !== undefined) {
          hidden = opts.hidden;
        } else {
          const hiddenStr = (
            await prompt(rl!, "Hidden? (y/N): ")
          ).trim().toLowerCase();
          hidden = hiddenStr === "y";
        }

        const body: CreateResourceBody = {
          name,
          description,
          url,
          params,
          hidden,
        };

        const created = await agentApi.createResource(agentId, body);

        if (json) {
          outputResult(json, created as unknown as Record<string, unknown>);
          return;
        }

        console.log(`\n${c.green("Resource created successfully!")}\n`);
        printResource(created);
      } catch (err) {
        outputError(
          json,
          `Failed to create resource: ${
            err instanceof Error ? err : String(err)
          }`
        );
      } finally {
        rl?.close();
      }
    });

  // UPDATE
  resource
    .command("update")
    .description("Update an existing resource for the active agent")
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      let resources: AgentResource[];
      try {
        const agent = await agentApi.getById(agentId);
        resources = agent.resources ?? [];
      } catch (err) {
        outputError(
          json,
          `Failed to fetch resources: ${
            err instanceof Error ? err : String(err)
          }`
        );
        return;
      }

      if (resources.length === 0) {
        outputError(json, "No resources found to update.");
        return;
      }

      const selected = await selectOption(
        "Choose a resource to update:",
        resources,
        (r) => `${r.name} — ${r.url}`
      );

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        console.log("\nPress Enter to keep current value.\n");

        const updates: UpdateResourceBody = {};

        const name = (
          await prompt(rl, `Name [${selected.name}]: `)
        ).trim();
        if (name) updates.name = name;

        const description = (
          await prompt(rl, `Description [${selected.description}]: `)
        ).trim();
        if (description) updates.description = description;

        const url = (
          await prompt(rl, `URL [${selected.url}]: `)
        ).trim();
        if (url) updates.url = url;

        const currentParamsDisplay = JSON.stringify(selected.params);
        const updateParams = (
          await prompt(
            rl,
            `Update params? Current: ${currentParamsDisplay} (y/N): `
          )
        ).trim().toLowerCase();
        if (updateParams === "y") {
          const paramsStr = (
            await prompt(rl, "New params JSON schema: ")
          ).trim();
          try {
            updates.params = validateJsonSchema(paramsStr);
          } catch (err) {
            outputError(json, err instanceof Error ? err : String(err));
            return;
          }
        }

        const hiddenStr = (
          await prompt(
            rl,
            `Hidden [${selected.isHidden ? "Yes" : "No"}] (y/n): `
          )
        ).trim().toLowerCase();
        if (hiddenStr === "y") updates.hidden = true;
        else if (hiddenStr === "n") updates.hidden = false;

        if (Object.keys(updates).length === 0) {
          console.log("No changes made.");
          return;
        }

        const updated = await agentApi.updateResource(
          agentId,
          selected.id,
          updates
        );

        if (json) {
          outputResult(json, updated as unknown as Record<string, unknown>);
          return;
        }

        console.log(`\n${c.green("Resource updated successfully!")}\n`);
        printResource(updated);
      } catch (err) {
        outputError(
          json,
          `Failed to update resource: ${
            err instanceof Error ? err : String(err)
          }`
        );
      } finally {
        rl.close();
      }
    });

  // DELETE
  resource
    .command("delete")
    .description("Delete a resource from the active agent")
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      let resources: AgentResource[];
      try {
        const agent = await agentApi.getById(agentId);
        resources = agent.resources ?? [];
      } catch (err) {
        outputError(
          json,
          `Failed to fetch resources: ${
            err instanceof Error ? err : String(err)
          }`
        );
        return;
      }

      if (resources.length === 0) {
        outputError(json, "No resources found to delete.");
        return;
      }

      const selected = await selectOption(
        "Choose a resource to delete:",
        resources,
        (r) => `${r.name} — ${r.url}`
      );

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        const confirm = (
          await prompt(rl, `Delete resource '${selected.name}'? (y/N): `)
        ).trim().toLowerCase();

        if (confirm !== "y") {
          console.log("Cancelled.");
          return;
        }

        await agentApi.deleteResource(agentId, selected.id);

        if (json) {
          outputResult(json, {
            success: true,
            deletedResource: selected.name,
          });
        } else {
          console.log(`\n${c.green(`Resource '${selected.name}' deleted successfully.`)}`);
        }
      } catch (err) {
        outputError(
          json,
          `Failed to delete resource: ${
            err instanceof Error ? err : String(err)
          }`
        );
      } finally {
        rl.close();
      }
    });
}
