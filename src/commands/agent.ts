import * as readline from "readline";
import type { Command } from "commander";
import {
  isJson,
  outputResult,
  outputError,
  isTTY,
  maskAddress,
} from "../lib/output";
import { CliError } from "../lib/errors";
import { c } from "../lib/color";
import {
  AgentApi,
  MigrationStatus,
  type Agent,
  LegacyAgent,
  Erc8004RegisterTx,
  Erc8004RegisterPayload,
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
  getPublicKey,
  setAgentId,
  getAgentId,
} from "../lib/config";
import { generateKeyPair as generateNativeKeyPair } from "../lib/acpCliSigner";
import { openBrowser } from "../lib/browser";
import {
  createAgentFromConfig,
  createProviderAdapter,
} from "../lib/agentFactory";
import { EvmAcpClient } from "@virtuals-protocol/acp-node-v2";
import {
  checkVirtualBalance,
  sendApprove,
  sendPreLaunch,
} from "../lib/tokenize";
import * as viemChains from "viem/chains";
import { formatEther, parseEther } from "viem";
import { formatChainId } from "../lib/chains";
import { deriveLocalPartFromName } from "./email";

function parseLegacyId(raw: string, json: boolean): number | null {
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    outputError(json, "Agent ID must be a number.");
    return null;
  }
  return id;
}

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
): Promise<boolean> {
  // 1. Generate key pair in native keystore (private key never leaves the binary)
  let publicKey: string;
  try {
    const result = generateNativeKeyPair();
    publicKey = result.publicKey;
  } catch (err) {
    outputError(
      json,
      `Failed to generate key pair: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }

  // 2. Get add signer URL
  let signerUrl: string;
  let requestId: string;
  try {
    const res = await api.addSignerWithUrl(agent.id);
    signerUrl = `${res.data.url}&publicKey=${publicKey}`;
    requestId = res.data.requestId;
  } catch (err) {
    outputError(
      json,
      `Failed to add signer: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }

  // 3. Present the URL and public key for the user to verify and approve
  if (json) {
    outputResult(json, {
      signerUrl,
      publicKey,
      expiresIn: "5 minutes",
    });
  } else {
    console.log(`\nPublic Key: ${publicKey}`);
    console.log(
      `\nOpening browser to verify the public key and approve the signer...`
    );
    console.log(`\n  ${signerUrl}\n`);
    console.log(`This link expires in 5 minutes.\n`);
    openBrowser(signerUrl);
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
        return false;
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
      return false;
    }
  }

  // 4. Persist public key reference to config (private key already stored by native binary)
  const evmProvider = agent.walletProviders.find(
    (wp) => (wp.chainType ?? "EVM") === "EVM"
  );

  if (!evmProvider?.metadata.walletId) {
    outputError(json, "EVM wallet provider not found for this agent.");
    return false;
  }

  setPublicKey(agent.walletAddress, publicKey);
  setWalletId(agent.walletAddress, evmProvider.metadata.walletId);

  if (json) {
    outputResult(json, {
      agentId: agent.id,
      agentName: agent.name,
    });
  } else {
    console.log(`\nSigner added to ${agent.name} successfully!`);
  }
  return true;
}

async function runRegisterErc8004Flow(
  agentApi: AgentApi,
  json: boolean,
  agent: Agent,
  chainId: number,
  chainName: string
): Promise<boolean> {
  let registerData: Erc8004RegisterTx;
  try {
    registerData = await agentApi.getErc8004RegisterData(agent.id, chainId);
  } catch (err) {
    outputError(
      json,
      `Failed to prepare ERC-8004 registration: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }

  const previousWallet = getActiveWallet();

  let payload: Erc8004RegisterPayload = {
    type: registerData.type,
    chainId,
  };

  try {
    setActiveWallet(agent.walletAddress);
    const walletProvider = await createProviderAdapter();

    if (!json) {
      console.log(`\nRegistering ${agent.name} on ${chainName}...`);
    }

    if (registerData.type === "register") {
      const result = await walletProvider.sendCalls(chainId, [
        {
          to: registerData.data.to as `0x${string}`,
          data: registerData.data.data as `0x${string}`,
        },
      ]);
      payload.txHash = Array.isArray(result) ? result[0] : result;
    } else if (registerData.type === "set-agent-wallet") {
      const signingData = registerData.data.typedData;

      if (!signingData) {
        outputError(json, "No signing data found.");
        return false;
      }

      const typedDataArgs = {
        domain: {
          name: signingData.domain.name,
          version: signingData.domain.version,
          chainId: signingData.domain.chainId,
          verifyingContract: signingData.domain
            .verifyingContract as `0x${string}`,
        },
        types: {
          AgentWalletSet: signingData.types.AgentWalletSet,
        } as Record<string, { name: string; type: string }[]>,
        primaryType: "AgentWalletSet" as const,
        message: {
          agentId: BigInt(signingData.agentId),
          newWallet: signingData.newWallet as `0x${string}`,
          owner: signingData.owner as `0x${string}`,
          deadline: BigInt(signingData.deadline),
        },
      };

      const signature = await walletProvider.signTypedData(
        chainId,
        typedDataArgs
      );

      payload.signature = signature;
      payload.ownerAddress = signingData.owner as `0x${string}`;
      payload.deadline = signingData.deadline.toString();
    } else {
      outputError(json, "Unsupported registration type.");
      return false;
    }
  } catch (err) {
    outputError(
      json,
      `Failed to register on ERC-8004: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  } finally {
    if (previousWallet) setActiveWallet(previousWallet);
  }

  try {
    if (!json) console.log("Finalizing registration...");
    const message = await agentApi.confirmErc8004Register(agent.id, payload);
    if (!json) console.log(message);
  } catch (err) {
    outputError(
      json,
      `Registration finalization failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }

  return true;
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Manage ACP agents");

  agent
    .command("create")
    .description("Create a new agent")
    .option("--name <name>", "Agent name")
    .option("--description <text>", "Agent description")
    .option("--image <url>", "Agent image URL")
    .option("--signer", "Automatically set up a signer after creation")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      let name: string = opts.name?.trim() ?? "";
      let description: string = opts.description?.trim() ?? "";
      let image: string | undefined = opts.image?.trim() || undefined;

      const needsPrompt = !name || !description || image === undefined;
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

        if (image === undefined) {
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

      let emailAddress: string | undefined;
      let emailError: string | undefined;
      try {
        const localPart = deriveLocalPartFromName(created.name);
        if (localPart) {
          const result = await agentApi.provisionEmailIdentity(
            created.id,
            created.name,
            localPart
          );
          emailAddress = result.emailAddress;
        }
      } catch (err) {
        emailError = err instanceof Error ? err.message : String(err);
      }

      if (json) {
        outputResult(json, {
          name: created.name,
          description: created.description,
          walletAddress: created.walletAddress,
          emailAddress,
          ...(emailError ? { emailError } : {}),
        });
        return;
      }

      console.log(
        `\n${c.green(`${created.name} has been created successfully!`)}\n`
      );

      const tableRows: [string, string][] = [
        ["Name", created.name],
        ["Description", created.description],
        ["Wallet Address", created.walletAddress ?? "N/A"],
      ];
      if (emailAddress) tableRows.push(["Email", emailAddress]);
      printTable(tableRows);

      if (emailAddress) {
        console.log(
          `\n${c.green("An email identity has been created for this agent:")} ${c.cyan(emailAddress)}`
        );
      } else if (emailError) {
        console.log(
          `\n${c.yellow("Could not provision email identity:")} ${emailError}`
        );
      }

      let setupSigner = opts.signer === true;

      if (!setupSigner) {
        const signerRl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) =>
          signerRl.question(
            "\nWould you like to set up a signer for this agent? (y/N) ",
            resolve
          )
        );
        signerRl.close();
        setupSigner = answer.toLowerCase() === "y";
      }

      if (!setupSigner) {
        return;
      }

      const signerOk = await runAddSignerFlow(agentApi, json, created);
      if (!signerOk) return;

      try {
        const acpAgent = await createAgentFromConfig();
        const client = acpAgent.getClient();
        if (!(client instanceof EvmAcpClient)) return;

        const chainIds = await client.getProvider().getSupportedChainIds();
        if (chainIds.length === 0) return;

        const firstChainId = chainIds[0];
        const chainById = new Map<number, string>(
          Object.values(viemChains).map((c) => [c.id, c.name])
        );
        const chainName =
          chainById.get(firstChainId) ?? `Chain ${firstChainId}`;

        await runRegisterErc8004Flow(
          agentApi,
          json,
          created,
          firstChainId,
          chainName
        );
      } catch (err) {
        outputError(
          json,
          `Failed to auto-register on ERC-8004: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
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
        }

        if (isTTY()) {
          for (const a of data) {
            console.log(`\n  ${c.bold("Name:")}           ${c.cyan(a.name)}`);
            console.log(`  ${c.bold("ID:")}             ${a.id}`);
            console.log(`  ${c.bold("Description:")}    ${a.description}`);
            console.log(`  ${c.bold("Role:")}           ${a.role}`);
            console.log(
              `  ${c.bold("Wallet:")}         ${c.dim(a.walletAddress)}`
            );
            console.log(`  ${c.bold("Created:")}        ${c.dim(a.createdAt)}`);
          }
          console.log(
            `\n${c.dim(
              `Page ${meta.pagination.page} of ${meta.pagination.pageCount} (${meta.pagination.total} total)`
            )}`
          );
        } else {
          console.log("ID\tNAME\tROLE\tWALLET");
          for (const a of data) {
            console.log(`${a.id}\t${a.name}\t${a.role}\t${a.walletAddress}`);
          }
        }
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
        outputError(
          json,
          new CliError(
            "No active agent set.",
            "NO_ACTIVE_AGENT",
            "Run `acp agent use` to set an active agent."
          )
        );
        return;
      }

      const agentId = getAgentId(activeWallet);
      if (!agentId) {
        outputError(
          json,
          new CliError(
            "Agent ID not found for active wallet.",
            "NO_ACTIVE_AGENT",
            "Run `acp agent list` or `acp agent use` to populate it."
          )
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

      if (isTTY()) {
        const agentChains = agentData.chains ?? [];

        const supportedChains = await createProviderAdapter().then((provider) =>
          provider.getSupportedChainIds()
        );

        let tokenRows: [string, string][] = [];

        for (const chainId of supportedChains) {
          const selectedChain = agentChains.find(
            (ch) => ch.chainId === chainId
          );
          const tokenAddress = selectedChain?.tokenAddress;
          const erc8004AgentId = selectedChain?.erc8004AgentId;

          tokenRows.push([
            "Token",
            `${tokenAddress ?? "Not tokenized"} [${formatChainId(chainId)}]`,
          ]);

          tokenRows.push([
            "ERC8004",
            `${
              erc8004AgentId ? `ID ${erc8004AgentId}` : "Not registered"
            } [${formatChainId(chainId)}]`,
          ]);
        }

        console.log(`\n${c.bold("Agent Details:")}`);
        printTable([
          ["ID", agentData.id],
          ["Name", c.cyan(agentData.name)],
          ["Description", agentData.description],
          ["Role", agentData.role],
          ["Wallet Address", agentData.walletAddress ?? "N/A"],
          ["Sol Wallet Address", agentData.solWalletAddress ?? "N/A"],
          ["Hidden", agentData.isHidden ? "Yes" : "No"],
          ["Image", agentData.imageUrl ?? "N/A"],
          ["Created", agentData.createdAt],
          ...tokenRows,
        ]);

        console.log(`\n${c.bold("Offerings:")}`);
        if (agentData.offerings?.length) {
          for (const o of agentData.offerings) {
            printTable([
              ["ID", o.id],
              ["Name", o.name],
              ["Description", o.description],
              ["Price", `${o.priceValue} (${o.priceType})`],
              ["SLA", `${o.slaMinutes} min`],
              ["Hidden", o.isHidden ? "Yes" : "No"],
            ]);
          }
        } else {
          console.log("  N/A");
        }

        console.log(`\n${c.bold("Resources:")}`);
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
      } else {
        console.log(
          `${agentData.name}\t${agentData.role}\t${
            agentData.walletAddress ?? "N/A"
          }\t${agentData.id}`
        );
      }
    });

  agent
    .command("update")
    .description("Update the active agent's name, description, or image")
    .option("--name <name>", "New agent name")
    .option("--description <text>", "New agent description")
    .option("--image <url>", "New agent image URL")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const name: string | undefined = opts.name?.trim() || undefined;
      const description: string | undefined =
        opts.description?.trim() || undefined;
      const imageUrl: string | undefined = opts.image?.trim() || undefined;

      if (!name && !description && imageUrl === undefined) {
        outputError(
          json,
          "Provide at least one of --name, --description, or --image to update."
        );
        return;
      }

      const activeWallet = getActiveWallet();
      if (!activeWallet) {
        outputError(
          json,
          new CliError(
            "No active agent set.",
            "NO_ACTIVE_AGENT",
            "Run `acp agent use` to set an active agent."
          )
        );
        return;
      }

      const agentId = getAgentId(activeWallet);
      if (!agentId) {
        outputError(
          json,
          new CliError(
            "Agent ID not found for active wallet.",
            "NO_ACTIVE_AGENT",
            "Run `acp agent list` or `acp agent use` to populate it."
          )
        );
        return;
      }

      const body: Parameters<typeof agentApi.update>[1] = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (imageUrl !== undefined) body.image = imageUrl;

      let updated: Agent;
      try {
        updated = await agentApi.update(agentId, body);
      } catch (err) {
        outputError(
          json,
          `Failed to update agent: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      if (json) {
        outputResult(json, {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          imageUrl: updated.imageUrl,
        });
        return;
      }

      console.log(
        `\n${c.green(`${updated.name} has been updated successfully!`)}\n`
      );
      printTable([
        ["Name", updated.name],
        ["Description", updated.description],
        ["Image", updated.imageUrl ?? "N/A"],
      ]);
    });

  agent
    .command("tokenize")
    .description("Tokenize the active agent on a blockchain")
    .option("--chain-id <id>", "Chain ID to tokenize on")
    .option("--symbol <symbol>", "Token symbol")
    .option(
      "--anti-sniper <type>",
      "Anti-sniper protection: 0 (none), 1 (60s), 2 (98min)"
    )
    .option(
      "--prebuy <virtuals>",
      "Pre-buy amount in VIRTUAL tokens to spend at launch (e.g. 100 = 100 VIRTUAL)"
    )
    .option(
      "--acf",
      "Enable Agent Capital Formation (higher launch fee; enables dev allocation + sell wall)"
    )
    .option(
      "--60-days",
      "Enable 60 Days Experiment mode (reversible launch; 60-day cliff on pre-buy; Vibes tokenomics)"
    )
    .option(
      "--airdrop-percent <percent>",
      "Airdrop allocation to veVIRTUAL holders (0–5%, e.g. 1.25)"
    )
    .option("--robotics", "Mark as a Robotics (Eastworld-eligible) launch")
    .option("--configure", "Show advanced launch configuration options")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      // Step 1: Resolve the active agent
      const activeWallet = getActiveWallet();
      if (!activeWallet) {
        outputError(
          json,
          new CliError(
            "No active agent set.",
            "NO_ACTIVE_AGENT",
            "Run `acp agent use` to set an active agent."
          )
        );
        return;
      }

      // Step 2: Ensure a signer is registered for this agent
      if (!getPublicKey(activeWallet)) {
        outputError(
          json,
          new CliError(
            "No signer configured for the active agent.",
            "NO_SIGNER",
            "Run `acp agent add-signer` to register a signing key before tokenizing."
          )
        );
        return;
      }

      const agentId = getAgentId(activeWallet);
      if (!agentId) {
        outputError(
          json,
          new CliError(
            "Agent ID not found for active wallet.",
            "NO_ACTIVE_AGENT",
            "Run `acp agent list` or `acp agent use` to populate it."
          )
        );
        return;
      }

      let selected: Agent;
      try {
        selected = await agentApi.getById(agentId);
      } catch (err) {
        outputError(
          json,
          `Failed to fetch agent: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      // Step 2b: Ensure agent has not already been tokenized
      const existingToken = selected.chains?.find((c) => c.tokenAddress);
      if (existingToken) {
        outputError(
          json,
          new CliError(
            `Agent ${
              selected.name
            } is already tokenized on chain ${formatChainId(
              existingToken.chainId
            )}.`,
            "ALREADY_TOKENIZED",
            "Each agent can only be tokenized once on a single chain."
          )
        );
        return;
      }

      // Step 3: Resolve chain options from the EVM provider
      let providerChains: { id: number; name: string }[];
      try {
        const provider = await createProviderAdapter();
        const chainIds = await provider.getSupportedChainIds();
        const chainById = new Map<number, string>(
          (Object.values(viemChains) as { id?: number; name?: string }[])
            .filter(
              (c) => typeof c?.id === "number" && typeof c?.name === "string"
            )
            .map((c) => [c.id as number, c.name as string])
        );
        providerChains = chainIds.map((id) => ({
          id,
          name: chainById.get(id) ?? `Chain ${id}`,
        }));
      } catch (err) {
        outputError(
          json,
          `Failed to load provider chains: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      if (providerChains.length === 0) {
        outputError(json, "Provider has no supported chains.");
        return;
      }

      let selectedChain: (typeof providerChains)[number];
      if (opts.chainId) {
        const match = providerChains.find(
          (c) => c.id.toString() === opts.chainId
        );
        if (!match) {
          outputError(
            json,
            `Unsupported chain ID: ${opts.chainId}. Supported: ${providerChains
              .map((c) => `${c.name} (${c.id})`)
              .join(", ")}`
          );
          return;
        }
        selectedChain = match;
      } else if (providerChains.length === 1) {
        selectedChain = providerChains[0];
      } else {
        selectedChain = await selectOption(
          "\nChoose a chain to tokenize on:",
          providerChains,
          (chain) => chain.name
        );
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

      // Step 4: Anti-sniper selection
      let antiSniperTaxType = 1; // default: 60 seconds
      if (opts.antiSniper !== undefined) {
        const parsed = Number(opts.antiSniper);
        if (![0, 1, 2].includes(parsed)) {
          outputError(
            json,
            `Invalid anti-sniper type: ${opts.antiSniper}. Must be 0, 1, or 2.`
          );
          return;
        }
        antiSniperTaxType = parsed;
      } else if (opts.configure && !json) {
        const antiSniperChoice = await selectOption(
          "\nChoose anti-sniper protection duration:",
          [
            { value: 1, label: "60 seconds (default)" },
            { value: 0, label: "None (0 seconds)" },
            { value: 2, label: "98 minutes" },
          ],
          (opt) => opt.label
        );
        antiSniperTaxType = antiSniperChoice.value;
      }

      // Step 5: Pre-buy amount (VIRTUAL to spend at launch)
      let prebuyVirtualWei = 0n;
      const parsePrebuy = (raw: string): bigint | null => {
        const trimmed = raw.trim();
        if (!trimmed) return 0n;
        if (!/^\d*\.?\d+$/.test(trimmed)) return null;
        try {
          const wei = parseEther(trimmed as `${number}`);
          return wei < 0n ? null : wei;
        } catch {
          return null;
        }
      };
      if (opts.prebuy !== undefined) {
        const wei = parsePrebuy(String(opts.prebuy));
        if (wei === null) {
          outputError(
            json,
            `Invalid --prebuy value: ${opts.prebuy}. Must be a non-negative number of VIRTUAL tokens.`
          );
          return;
        }
        prebuyVirtualWei = wei;
      } else if (opts.configure && !json) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const raw = await prompt(
            rl,
            "\nPre-buy amount in VIRTUAL tokens (blank to skip): "
          );
          const wei = parsePrebuy(raw);
          if (wei === null) {
            outputError(
              json,
              `Invalid pre-buy value: ${raw}. Must be a non-negative number.`
            );
            return;
          }
          prebuyVirtualWei = wei;
        } finally {
          rl.close();
        }
      }

      // Step 6: Capital Formation (ACF) toggle
      let needAcf = false;
      if (opts.acf) {
        needAcf = true;
      } else if (opts.configure && !json) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const raw = (
            await prompt(rl, "\nEnable Capital Formation (ACF)? (y/N): ")
          )
            .trim()
            .toLowerCase();
          needAcf = raw === "y" || raw === "yes";
        } finally {
          rl.close();
        }
      }

      // Step 6b: 60 Days Experiment toggle
      let isProject60days = false;
      if (opts["60Days"]) {
        isProject60days = true;
      } else if (opts.configure && !json) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const raw = (await prompt(rl, "\nEnable 60 Days Experiment? (y/N): "))
            .trim()
            .toLowerCase();
          isProject60days = raw === "y" || raw === "yes";
        } finally {
          rl.close();
        }
      }

      // Step 6c: Airdrop percent (0–5%)
      let airdropPercent = 0;
      const parseAirdropPercent = (raw: string): number | null => {
        const trimmed = raw.trim();
        if (!trimmed) return 0;
        if (!/^\d*\.?\d+$/.test(trimmed)) return null;
        const n = Number(trimmed);
        if (!Number.isFinite(n) || n < 0 || n > 5) return null;
        return n;
      };
      if (opts.airdropPercent !== undefined) {
        const n = parseAirdropPercent(String(opts.airdropPercent));
        if (n === null) {
          outputError(
            json,
            `Invalid --airdrop-percent value: ${opts.airdropPercent}. Must be a number between 0 and 5.`
          );
          return;
        }
        airdropPercent = n;
      } else if (opts.configure && !json) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const raw = await prompt(
            rl,
            "\nAirdrop percentage to veVIRTUAL holders (0–5, blank to skip): "
          );
          const n = parseAirdropPercent(raw);
          if (n === null) {
            outputError(
              json,
              `Invalid airdrop percent: ${raw}. Must be a number between 0 and 5.`
            );
            return;
          }
          airdropPercent = n;
        } finally {
          rl.close();
        }
      }
      // Step 6d: Robotics Launch
      let isRobotics = false;
      if (opts.robotics) {
        isRobotics = true;
      } else if (opts.configure && !json) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const raw = (
            await prompt(
              rl,
              "\nMark as Robotics (Eastworld-eligible) launch? (y/N): "
            )
          )
            .trim()
            .toLowerCase();
          isRobotics = raw === "y" || raw === "yes";
        } finally {
          rl.close();
        }
      }

      // Step 7: Prepare launch (backend creates virtual + saves launchInfo)
      let prepareLaunchResponse: Awaited<
        ReturnType<typeof agentApi.prepareLaunch>
      >;
      try {
        if (!json) console.log(`\nPreparing token launch...`);

        prepareLaunchResponse = await agentApi.prepareLaunch(
          selected.id,
          selectedChain.id,
          symbol,
          antiSniperTaxType,
          needAcf,
          isProject60days,
          airdropPercent,
          isRobotics,
          prebuyVirtualWei > 0n ? prebuyVirtualWei.toString() : undefined
        );
      } catch (err) {
        outputError(
          json,
          `Failed to prepare launch: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      const {
        virtualId,
        contracts,
        launchFee,
        approveCalldata,
        preLaunchCalldata,
      } = prepareLaunchResponse;

      const launchFeeWei = BigInt(launchFee);
      const totalApprovalWei = launchFeeWei + prebuyVirtualWei;

      // Step 8: On-chain — approve VIRTUAL token + call preLaunch
      let preLaunchTxHash: string;
      try {
        await checkVirtualBalance(
          selectedChain.id,
          contracts.virtualToken,
          selected.walletAddress,
          totalApprovalWei.toString()
        );
        if (!json && needAcf) {
          console.log(
            `Launch fee (with ACF): ${formatEther(launchFeeWei)} VIRTUAL`
          );
        }
        if (!json && isProject60days) {
          console.log(
            `60 Days Experiment enabled — pre-buy tokens will follow a 60-day cliff.`
          );
        }
        if (!json && airdropPercent > 0) {
          console.log(
            `Airdrop: allocating ${airdropPercent}% of supply to veVIRTUAL holders.`
          );
        }
        if (!json && isRobotics) {
          console.log(`Robotics Launch: enabled (Eastworld eligibility).`);
        }
        if (!json && prebuyVirtualWei > 0n) {
          console.log(
            `Pre-buying ${formatEther(prebuyVirtualWei)} VIRTUAL of $${symbol}`
          );
        }
        if (!json) console.log(`Approving VIRTUAL token...`);

        await sendApprove(
          selectedChain.id,
          contracts.virtualToken,
          approveCalldata
        );

        if (!json) console.log(`Calling preLaunch contract...`);
        preLaunchTxHash = await sendPreLaunch(
          selectedChain.id,
          contracts.bondingV5,
          preLaunchCalldata
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const hints: string[] = [];
        if (needAcf && prebuyVirtualWei > 0n) {
          hints.push("with ACF enabled, pre-buy must be ≤50% of LP");
        }
        if (airdropPercent > 0 && prebuyVirtualWei > 0n) {
          hints.push(
            `airdrop reserves ${airdropPercent}% of supply before LP, reducing pre-buy headroom`
          );
        }
        const hint = hints.length
          ? ` Hint: ${hints.join("; ")}; reduce --prebuy and retry.`
          : "";
        outputError(json, `Failed to launch token: ${msg}${hint}`);
        return;
      }

      if (!json) {
        console.log(
          `\nAgent ${selected.name} tokenized successfully as $${symbol}`
        );
        console.log(`Transaction: ${preLaunchTxHash}`);
      } else {
        outputResult(json, {
          success: true,
          agentId: selected.id,
          agentName: selected.name,
          virtualId,
          txHash: preLaunchTxHash,
          needAcf,
          isProject60days,
          airdropPercent,
          isRobotics,
          launchFee: launchFeeWei.toString(),
        });
      }
    });

  agent
    .command("register-erc8004")
    .description("Register an agent on the ERC-8004 identity registry")
    .option("--agent-id <id>", "Agent ID")
    .option("--chain-id <id>", "Chain ID to register on")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const acpAgent = await createAgentFromConfig();
      const client = acpAgent.getClient();

      if (!(client instanceof EvmAcpClient)) {
        outputError(
          json,
          "Only EVM chains are supported for ERC-8004 registration."
        );
        return;
      }

      const provider = client.getProvider();

      const providerChains = await provider.getSupportedChainIds();
      const chainNames = new Map<number, string>(
        Object.values(viemChains).map((c) => [c.id, c.name])
      );
      const erc8004Chains = providerChains.map((id) => ({
        id,
        name: chainNames.get(id) ?? `Chain ${id}`,
      }));

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
          "Choose the agent to register on ERC-8004:",
          agents
        );
      }

      // Step 2: Select chain
      let selectedChain: { id: number; name: string };
      if (opts.chainId) {
        const match = erc8004Chains.find(
          (c) => c.id.toString() === opts.chainId
        );
        if (!match) {
          outputError(
            json,
            `Unsupported chain ID: ${opts.chainId}. Supported: ${erc8004Chains
              .map((c) => `${c.name} (${c.id})`)
              .join(", ")}`
          );
          return;
        }
        selectedChain = match;
      } else {
        selectedChain = await selectOption(
          "\nChoose a chain to register on:",
          erc8004Chains,
          (chain) => chain.name
        );
      }

      // Step 3: Run ERC-8004 registration flow
      const success = await runRegisterErc8004Flow(
        agentApi,
        json,
        selected,
        selectedChain.id,
        selectedChain.name
      );
      if (!success) return;

      if (json) {
        outputResult(json, {
          success: true,
          agentId: selected.id,
          agentName: selected.name,
          chainId: selectedChain.id,
        });
      }
    });

  agent
    .command("migrate")
    .option("--agent-id <id>", "Agent ID")
    .option("--complete", "Complete a migration")
    .description(
      "Migrate a legacy agent to ACP SDK 2.0, or complete an in-progress migration"
    )
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      // Complete agent migration flow
      if (opts.complete) {
        if (!opts.agentId) {
          outputError(
            json,
            "Please provide the agent ID to complete migration."
          );
          return;
        }
        const numericId = parseLegacyId(opts.agentId, json);
        if (numericId === null) return;

        let legacyAgents: LegacyAgent[];
        try {
          legacyAgents = await agentApi.getLegacyAgents();
        } catch (err) {
          outputError(
            json,
            `Failed to fetch legacy agents: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          return;
        }

        const match = legacyAgents.find((a) => a.id === numericId);
        if (!match) {
          outputError(
            json,
            `Agent with ID ${numericId} not found in legacy agents.`
          );
          return;
        }

        const startMigrationCommand = `acp agent migrate --agent-id ${match.id}`;

        switch (match.migrationStatus) {
          case MigrationStatus.PENDING:
            outputError(
              json,
              `Agent "${match.name}" is not yet created. Run ${startMigrationCommand} to start migrating the agent.`
            );
            return;
          case MigrationStatus.COMPLETED:
            outputError(
              json,
              `Agent "${match.name}" has already been migrated.`
            );
            return;
          case MigrationStatus.IN_PROGRESS:
            break;
          default:
            outputError(
              json,
              `Agent "${match.name}" has an unexpected migration status: ${match.migrationStatus}.`
            );
            return;
        }

        const agents = await agentApi.list();
        const selectedAgent = agents.data.find((a) =>
          a.chains.find((c) => c.acpV2AgentId === numericId)
        );

        if (!selectedAgent) {
          outputError(
            json,
            `No migrated agent found linked to legacy agent ID ${numericId}.`
          );
          return;
        }

        await agentApi.update(selectedAgent.id, { isHidden: false });

        setActiveWallet(selectedAgent.walletAddress);
        setAgentId(selectedAgent.walletAddress, selectedAgent.id);

        if (json) {
          outputResult(json, {
            success: true,
            activeAgent: match.name,
            walletAddress: match.walletAddress,
          });
        } else {
          console.log(
            `\nAgent "${match.name}" has been migrated successfully! This is your active agent now.`
          );
        }
        return;
      }

      // Main migrate flow
      let legacyAgents: LegacyAgent[];
      try {
        legacyAgents = await agentApi.getLegacyAgents();
      } catch (err) {
        outputError(
          json,
          `Failed to fetch legacy agents: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      if (legacyAgents.length === 0) {
        outputError(json, "No legacy agents to migrate.");
        return;
      }

      let selected: LegacyAgent;
      const instructions =
        "Before proceeding, read migration.md and ensure all prerequisites are complete.";

      if (opts.agentId) {
        const numericId = parseLegacyId(opts.agentId, json);
        if (numericId === null) return;
        const found = legacyAgents.find((a) => a.id === numericId);
        if (!found) {
          outputError(
            json,
            `Agent with ID ${opts.agentId} not found in legacy agents.`
          );
          return;
        }
        selected = found;
      } else {
        selected = await selectOption(
          "Select an agent to migrate:",
          legacyAgents,
          (a) =>
            `${a.name} ${maskAddress(a.walletAddress)} [${a.migrationStatus}]`
        );
      }

      const completeMigrationCommand = `acp agent migrate --agent-id ${selected.id} --complete`;

      switch (selected.migrationStatus) {
        case MigrationStatus.IN_PROGRESS:
          outputError(
            json,
            `Agent "${selected.name}" migration is in progress. Run ${completeMigrationCommand} to complete the migration.`
          );
          return;
        case MigrationStatus.COMPLETED:
          outputError(
            json,
            `Agent "${selected.name}" has already been migrated.`
          );
          return;
        case MigrationStatus.PENDING:
          break;
        default:
          outputError(
            json,
            `Agent "${selected.name}" has an unexpected migration status: ${selected.migrationStatus}.`
          );
          return;
      }

      if (!json) {
        console.log(`\nMigrating "${selected.name}"...`);
      }

      let migratedAgent: Agent;
      try {
        migratedAgent = await agentApi.migrateAgent(selected.id);
      } catch (err) {
        outputError(
          json,
          `Failed to migrate agent: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      if (!json) {
        console.log("Migration initiated. Setting up signer...\n");
      }

      const signerOk = await runAddSignerFlow(agentApi, json, migratedAgent);
      if (!signerOk) return;

      if (!json) {
        console.log(
          `Your agent has been created. ${instructions}\n\nWhen you are ready to activate this agent, run:\n\n  ${completeMigrationCommand}`
        );
      } else {
        outputResult(json, {
          success: true,
          acpAgentId: selected.id,
          agentName: selected.name,
          instructions,
          nextStep: completeMigrationCommand,
        });
      }
    });
}
