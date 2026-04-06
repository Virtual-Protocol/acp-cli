import * as readline from "readline";
import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output";
import {
  AgentApi,
  TokenizeResponse,
  TokenizeStatusResponse,
  type Agent,
} from "../lib/api/agent";
import { getClient } from "../lib/api/client";
import {
  prompt,
  selectFromList,
  selectOption,
  printTable,
} from "../lib/prompt";
import {
  setPublicKey,
  setWalletId,
  setActiveWallet,
  getActiveWallet,
  setAgentId,
  getAgentId,
} from "../lib/config";
import { generateP256KeyPair, P256KeyPair } from "@privy-io/node";
import { storeSignerKey } from "../lib/signerKeychain";
import { createAgentFromConfig } from "../lib/agentFactory";
import { EvmAcpClient, SUPPORTED_CHAINS } from "acp-node-v2";

async function resolveAgent(
  agentApi: AgentApi,
  opts: { walletAddress?: string; agentId?: string },
  json: boolean
): Promise<Agent | null> {
  if (opts.agentId) {
    try {
      return await agentApi.getById(opts.agentId);
    } catch (err) {
      outputError(
        json,
        `Failed to fetch agent: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      process.exit(1);
    }
  }
  if (opts.walletAddress) {
    try {
      const result = await agentApi.list();
      const match = result.data.find(
        (a) => a.walletAddress === opts.walletAddress
      );
      if (!match) {
        outputError(
          json,
          `No agent found with wallet address: ${opts.walletAddress}`
        );
        process.exit(1);
      }
      return match;
    } catch (err) {
      outputError(
        json,
        `Failed to fetch agents: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      process.exit(1);
    }
  }
  return null;
}

async function runAddSignerFlow(
  api: AgentApi,
  json: boolean,
  agent: Agent
): Promise<void> {
  // 1. Generate key pair and persist private key to keychain
  let keypair: P256KeyPair;
  try {
    keypair = await generateP256KeyPair();
  } catch (err) {
    outputError(
      json,
      `Failed to generate key pair: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }

  // 2. Get add signer URL
  let signerUrl: string;
  let requestId: string;
  try {
    const res = await api.addSignerWithUrl(agent.id);
    signerUrl = `${res.data.url}&publicKey=${keypair.publicKey}`;
    requestId = res.data.requestId;
  } catch (err) {
    outputError(
      json,
      `Failed to add signer: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }

  // 3. Present the URL and public key for the user to verify and approve
  if (json) {
    outputResult(json, {
      signerUrl,
      publicKey: keypair.publicKey,
      expiresIn: "5 minutes",
    });
  } else {
    console.log(`\nPublic Key: ${keypair.publicKey}`);
    console.log(
      `\nPlease visit the following URL to verify the public key and approve the signer:`
    );
    console.log(`\n  ${signerUrl}\n`);
    console.log(`This link expires in 5 minutes.\n`);
    console.log(`Waiting for approval...`);
  }

  // 3b. Poll signer status until completed or timeout (5 minutes)
  const POLL_INTERVAL_MS = 5_000;
  const TIMEOUT_MS = 5 * 60 * 1_000;
  const startTime = Date.now();

  while (Date.now() - startTime < TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const statusRes = await api.getSignerStatus(agent.id, requestId);

      if (!statusRes.data.status) {
        outputError(json, "Signer registration not found. Please try again.");
        return;
      }

      if (statusRes.data.status === "completed") {
        if (!json) {
          console.log("Signer registration approved.");
        }
        break;
      }
    } catch {
      // Ignore transient polling errors and retry
    }

    if (Date.now() - startTime >= TIMEOUT_MS) {
      outputError(json, "Signer registration timed out. Please try again.");
      return;
    }
  }

  // 4. Persist public key to config and keychain (only after all API calls succeed)
  const walletId = agent.walletProviders[0].metadata.walletId;
  setPublicKey(agent.walletAddress, keypair.publicKey);
  setWalletId(agent.walletAddress, walletId);
  await storeSignerKey(keypair.publicKey, keypair.privateKey);

  if (json) {
    outputResult(json, {
      agentId: agent.id,
      agentName: agent.name,
    });
  } else {
    console.log(`\nSigner added to ${agent.name} successfully!`);
  }
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Manage ACP agents");

  agent
    .command("create")
    .description("Create a new agent")
    .option("--name <name>", "Agent name")
    .option("--description <text>", "Agent description")
    .option("--image <url>", "Agent image URL")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      let name: string = opts.name?.trim() ?? "";
      let description: string = opts.description?.trim() ?? "";
      let image: string | undefined = opts.image?.trim() || undefined;

      const needsPrompt =
        !name || !description || (image === undefined && !opts.image);
      let rl: readline.Interface | undefined;

      try {
        if (needsPrompt) {
          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
        }

        if (!name) {
          name = (await prompt(rl!, "Agent name: ")).trim();
          if (!name) {
            outputError(json, "Agent name cannot be empty.");
            return;
          }
        }

        if (!description) {
          description = (await prompt(rl!, "Agent description: ")).trim();
          if (!description) {
            outputError(json, "Agent description cannot be empty.");
            return;
          }
        }

        if (image === undefined && !opts.image) {
          if (rl) {
            const imageInput = (
              await prompt(
                rl,
                "Agent image URL (optional, press Enter to skip): "
              )
            ).trim();
            if (imageInput) {
              image = imageInput;
            }
          }
        }
      } finally {
        rl?.close();
      }

      let created: Agent;
      try {
        created = await agentApi.create(name, description, image);
      } catch (err) {
        outputError(
          json,
          `Failed to create agent: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      if (created.walletAddress) {
        setActiveWallet(created.walletAddress);
        setAgentId(created.walletAddress, created.id);
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

      await runAddSignerFlow(agentApi, json, created);
    });

  agent
    .command("list")
    .description("List all agents")
    .option("--page <number>", "Page number")
    .option("--page-size <number>", "Number of agents per page")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
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
          if (a.walletAddress) setAgentId(a.walletAddress, a.id);
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
    .command("use")
    .description("Set the active agent for all commands")
    .option("--agent-id <id>", "Agent ID")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      let selected = await resolveAgent(agentApi, opts, json);

      if (!selected) {
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
          outputError(json, "No agents found. Run `acp agent create` first.");
          return;
        }

        selected = await selectFromList(
          "Choose the agent to set as active:",
          agents
        );
      }

      setActiveWallet(selected.walletAddress);
      setAgentId(selected.walletAddress, selected.id);

      outputResult(json, {
        success: true,
        activeAgent: selected.name,
        walletAddress: selected.walletAddress,
      });
    });

  agent
    .command("add-signer")
    .description("Add a new signer to an agent")
    .option("--agent-id <id>", "Agent ID")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      let selected = await resolveAgent(agentApi, opts, json);

      if (!selected) {
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

        selected = await selectFromList(
          "Choose the agent you wish to add a new signer:",
          agents
        );
      }

      console.log(`\nSelected: ${selected.name} ${selected.walletAddress}`);

      await runAddSignerFlow(agentApi, json, selected);
    });

  agent
    .command("whoami")
    .description("Show details of the currently active agent")
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const activeWallet = getActiveWallet();
      if (!activeWallet) {
        outputError(json, "No active agent set. Run `acp agent use` first.");
        return;
      }

      const agentId = getAgentId(activeWallet);
      if (!agentId) {
        outputError(
          json,
          "Agent ID not found for active wallet. Run `acp agent list` or `acp agent use` to populate it."
        );
        return;
      }

      let agentData: Awaited<ReturnType<typeof agentApi.getById>>;
      try {
        agentData = await agentApi.getById(agentId);
      } catch (err) {
        outputError(
          json,
          `Failed to fetch agent: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      if (json) {
        outputResult(json, agentData as unknown as Record<string, unknown>);
        return;
      }

      const chainRows: [string, string][] = (agentData.chains ?? []).map(
        (c, i) => [`Chain ${c.chainId}`, `${c.tokenAddress ?? "Not tokenized"}`]
      );

      console.log("\nAgent Details:");
      printTable([
        ["ID", agentData.id],
        ["Name", agentData.name],
        ["Description", agentData.description],
        ["Role", agentData.role],
        ["Wallet Address", agentData.walletAddress ?? "N/A"],
        ["Hidden", agentData.isHidden ? "Yes" : "No"],
        ["Image", agentData.imageUrl ?? "N/A"],
        ["Created", agentData.createdAt],
        ...chainRows,
      ]);

      console.log("\nOfferings:");
      if (agentData.offerings?.length) {
        for (const o of agentData.offerings) {
          printTable([
            ["ID", o.id],
            ["Name", o.name],
            ["Description", o.description],
            ["Price", `${o.priceValue} (${o.priceType})`],
            ["SLA", `${o.slaMinutes} min`],
            ["Hidden", o.isHidden ? "Yes" : "No"],
            ["Private", o.isPrivate ? "Yes" : "No"],
          ]);
        }
      } else {
        console.log("  N/A");
      }

      console.log("\nResources:");
      if (agentData.resources?.length) {
        for (const r of agentData.resources) {
          printTable([
            ["ID", r.id],
            ["Name", r.name],
            ["Description", r.description],
            ["URL", r.url],
          ]);
        }
      } else {
        console.log("  N/A");
      }
    });

  agent
    .command("tokenize")
    .description("Tokenize an agent on a blockchain")
    .option("--wallet-address <address>", "Agent wallet address")
    .option("--agent-id <id>", "Agent ID")
    .option("--chain-id <id>", "Chain ID to tokenize on")
    .option("--symbol <symbol>", "Token symbol")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      // Step 1: Select agent
      let selected = await resolveAgent(agentApi, opts, json);

      if (!selected) {
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
          outputError(json, "No agents found. Run `acp agent create` first.");
          return;
        }

        selected = await selectFromList(
          "Choose the agent to tokenize:",
          agents
        );
      }

      // Step 2: Select chain
      let selectedChain: (typeof SUPPORTED_CHAINS)[number];
      if (opts.chainId) {
        const match = SUPPORTED_CHAINS.find(
          (c) => c.id.toString() === opts.chainId
        );
        if (!match) {
          outputError(
            json,
            `Unsupported chain ID: ${
              opts.chainId
            }. Supported: ${SUPPORTED_CHAINS.map(
              (c) => `${c.name} (${c.id})`
            ).join(", ")}`
          );
          return;
        }
        selectedChain = match;
      } else {
        selectedChain = await selectOption(
          "\nChoose a chain to tokenize on:",
          SUPPORTED_CHAINS,
          (chain) => chain.name
        );
      }

      // Check tokenize status
      let tokenizeDetails: TokenizeStatusResponse;
      try {
        tokenizeDetails = await agentApi.getTokenizeDetails(
          selected.id,
          selectedChain.id
        );
      } catch (err) {
        outputError(
          json,
          `Failed to fetch tokenize details: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      if (tokenizeDetails.hasTokenized) {
        outputError(json, `${selected.name} has already been tokenized.`);
        return;
      }

      // Step 3: Input token symbol
      let symbol: string;
      if (opts.symbol) {
        symbol = opts.symbol.trim().toUpperCase();
        if (!symbol) {
          outputError(json, "Token symbol cannot be empty.");
          return;
        }
      } else {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        try {
          symbol = (await prompt(rl, "\nEnter token symbol: "))
            .trim()
            .toUpperCase();
          if (!symbol) {
            outputError(json, "Token symbol cannot be empty.");
            return;
          }
        } finally {
          rl.close();
        }
      }

      // Step 4: Pay if not already paid
      let txHash = "";

      if (tokenizeDetails.hasPaid) {
        console.log("\nPayment already received, skipping transfer.");
      } else {
        const previousWallet = getActiveWallet();
        setActiveWallet(selected.walletAddress);

        try {
          console.log(`Sending payment for tokenization...`);

          const acpAgent = await createAgentFromConfig();
          const client = acpAgent.getClient();

          if (!(client instanceof EvmAcpClient)) {
            outputError(
              json,
              "Only EVM chains are supported for tokenization."
            );
            return;
          }

          const provider = client.getProvider();

          const result = await provider.sendCalls(selectedChain.id, [
            {
              to: tokenizeDetails.paymentToken as `0x${string}`,
              data: tokenizeDetails.paymentData as `0x${string}`,
            },
          ]);

          txHash = Array.isArray(result) ? result[0] : result;
        } catch (err) {
          outputError(
            json,
            `Failed to send payment: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          return;
        } finally {
          if (previousWallet) setActiveWallet(previousWallet);
        }
      }

      // Step 5: Call tokenize API
      let tokenizeResponse: TokenizeResponse;
      try {
        console.log(`Tokenizing your agent on chain ID ${selectedChain.id}...`);

        tokenizeResponse = await agentApi.tokenize(
          selected.id,
          selectedChain.id,
          symbol,
          txHash
        );
      } catch (err) {
        outputError(
          json,
          `Failed to tokenize agent: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      if (!json) {
        console.log(
          `\nAgent ${selected.name} tokenized successfully as $${symbol}, token address: ${tokenizeResponse.preToken}`
        );
      } else {
        outputResult(json, {
          success: true,
          agentId: selected.id,
          agentName: selected.name,
          tokenizeResponse,
        });
      }
    });
}
