import * as readline from "readline";
import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output.js";
import { AgentApi, getAgentApi, type Agent } from "../lib/api/agent.js";
import { generateKeyPair } from "../lib/acpCliSigner.js";
import { prompt, selectFromList, printTable } from "../lib/prompt.js";
import { setPublicKey } from "../lib/config.js";

async function runAddSignerFlow(
  api: AgentApi,
  json: boolean,
  agent: Agent
): Promise<void> {
  // 1. Generate key pair via acp-cli-signer
  let publicKey: string;
  try {
    publicKey = generateKeyPair();
  } catch (err) {
    outputError(
      json,
      `Failed to generate key pair: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }

  // 2. Register public key as quorum
  let keyQuorumId: string;
  try {
    const quorumRes = await api.addQuorum(agent.id, publicKey);
    keyQuorumId = quorumRes.data;
  } catch (err) {
    outputError(
      json,
      `Failed to add quorum: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }

  // 3. Register signer on the agent
  const walletId = agent.walletProviders[0].metadata.walletId;

  try {
    await api.addSigner(agent.id, walletId, keyQuorumId);
  } catch (err) {
    outputError(
      json,
      `Failed to add signer: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }

  // 4. Add public key to config.json
  setPublicKey(agent.walletAddress, publicKey);

  if (json) {
    outputResult(json, {
      agentId: agent.id,
      agentName: agent.name,
      keyQuorumId,
      publicKey,
    });
  } else {
    console.log(
      `\nNew signer ${publicKey} added to ${agent.name} successfully!`
    );
  }
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Manage ACP agents");

  const agentApi: AgentApi = getAgentApi();

  agent
    .command("create")
    .description("Create a new agent")
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      let name: string;
      let description: string;

      try {
        name = (await prompt(rl, "Agent name: ")).trim();
        if (!name) {
          outputError(json, "Agent name cannot be empty.");
          return;
        }

        description = (await prompt(rl, "Agent description: ")).trim();
        if (!description) {
          outputError(json, "Agent description cannot be empty.");
          return;
        }
      } finally {
        rl.close();
      }

      let created: Agent;
      try {
        created = await agentApi.create(name, description);
      } catch (err) {
        outputError(
          json,
          `Failed to create agent: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      if (json) {
        outputResult(json, {
          name: created.name,
          description: created.description,
          walletAddress: created.walletAddress,
        });
        return;
      }

      console.log(`\n${created.name} has been created successfully!\n`);

      printTable([
        ["Name", created.name],
        ["Description", created.description],
        ["Wallet Address", created.walletAddress ?? "N/A"],
      ]);

      const privyAppId = process.env.ACP_PRIVY_APP_ID;
      if (!privyAppId) {
        return;
      }

      const rl2 = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      let addSigner: string;
      try {
        addSigner = (
          await prompt(
            rl2,
            "\nDo you want to add a signer to this agent? (y/N): "
          )
        )
          .trim()
          .toLowerCase();
      } finally {
        rl2.close();
      }

      if (addSigner === "y" || addSigner === "yes") {
        await runAddSignerFlow(agentApi, json, created);
      }
    });

  agent
    .command("list")
    .description("List all agents")
    .option("--page <number>", "Page number")
    .option("--page-size <number>", "Number of agents per page")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      const page = opts.page ? parseInt(opts.page, 10) : undefined;
      const pageSize = opts.pageSize ? parseInt(opts.pageSize, 10) : undefined;

      try {
        const result = await agentApi.list(page, pageSize);
        const { data, meta } = result;

        if (json) {
          process.stdout.write(JSON.stringify(result) + "\n");
          return;
        }

        if (data.length === 0) {
          console.log("No agents found.");
          return;
        }

        for (const a of data) {
          console.log(`\n  ID:             ${a.id}`);
          console.log(`  Name:           ${a.name}`);
          console.log(`  Description:    ${a.description}`);
          console.log(`  Role:           ${a.role}`);
          console.log(`  Wallet:         ${a.walletAddress}`);
          console.log(`  Created:        ${a.createdAt}`);
        }

        console.log(
          `\nPage ${meta.pagination.page} of ${meta.pagination.pageCount} (${meta.pagination.total} total)`
        );
      } catch (err) {
        outputError(
          json,
          `Failed to list agents: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    });

  agent
    .command("add-signer")
    .description("Add a new signer to an agent")
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);

      // 1. Fetch agent list for selection
      let agents: Agent[];
      try {
        const result = await agentApi.list();
        agents = result.data;
      } catch (err) {
        outputError(
          json,
          `Failed to fetch agents: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      if (agents.length === 0) {
        outputError(json, "No agents found.");
        return;
      }

      // 2. Interactive agent selection
      const selected = await selectFromList(
        "Choose the agent you wish to add a new signer:",
        agents
      );
      console.log(`\nSelected: ${selected.name}`);

      // 3. Generate key pair via acp-cli-signer and persist to .env
      let publicKey: string;
      try {
        publicKey = generateKeyPair();
      } catch (err) {
        outputError(
          json,
          `Failed to generate key pair: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }
      setPublicKey(selected.walletAddress, publicKey);

      // 4. Register public key as quorum
      let keyQuorumId: string;
      try {
        const quorumRes = await agentApi.addQuorum(selected.id, publicKey);
        keyQuorumId = quorumRes.data;
      } catch (err) {
        outputError(
          json,
          `Failed to add quorum: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      const walletId = selected.walletProviders[0].metadata.walletId;

      // 5. Register signer on the agent
      try {
        await agentApi.addSigner(selected.id, walletId, keyQuorumId);
      } catch (err) {
        outputError(
          json,
          `Failed to add signer: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      if (json) {
        outputResult(json, {
          agentId: selected.id,
          agentName: selected.name,
          keyQuorumId,
          publicKey,
        });
      } else {
        console.log(
          `\nNew signer ${publicKey} added to ${selected.name} successfully!`
        );
      }
    });
}
