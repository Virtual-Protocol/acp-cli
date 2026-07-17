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
  type SignerPolicy,
  SIGNER_POLICIES,
} from "../lib/api/agent";
import { getClient } from "../lib/api/client";
import type { GlobalPolicy, Policy, WalletSigner } from "../lib/api/policy";
import { dashboardSignerPolicyUrl } from "../lib/dashboard";
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
import {
  EvmAcpClient,
  EVM_CHAINS,
  EVM_MAINNET_CHAINS,
  EVM_TESTNET_CHAINS,
} from "@virtuals-protocol/acp-node-v2";
import {
  tokenizeOnSolana,
  tokenizeOnEvm,
  convertPrebuyVirtual,
} from "../lib/tokenize";
import * as viemChains from "viem/chains";
import { formatChainId, solanaChainId, isSolanaChainId } from "../lib/chains";
import { formatEther, parseEther } from "viem";

// In --json mode the signer approval URL goes to stdout as JSON for machine
// parsing, but many agent harnesses buffer or suppress stdout while passing
// stderr through to the human. Mirroring a plain, copy-pasteable line to stderr
// guarantees the approval link reaches the human even if the agent never
// relays the JSON. Does not affect the stdout JSON contract.
function emitSignerUrlToStderr(url: string): void {
  process.stderr.write(
    `\n>>> Open this URL to approve the signer:\n\n    ${url}\n\n`,
  );
}

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
  json: boolean,
): Promise<Agent | null> {
  if (opts.agentId) {
    try {
      return await agentApi.getById(opts.agentId);
    } catch (err) {
      outputError(
        json,
        `Failed to fetch agent: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      process.exit(1);
    }
  }
  if (opts.walletAddress) {
    try {
      const result = await agentApi.list();
      const match = result.data.find(
        (a) => a.walletAddress === opts.walletAddress,
      );
      if (!match) {
        outputError(
          json,
          `No agent found with wallet address: ${opts.walletAddress}`,
        );
        process.exit(1);
      }
      return match;
    } catch (err) {
      outputError(
        json,
        `Failed to fetch agents: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      process.exit(1);
    }
  }
  return null;
}

const SIGNER_POLL_INTERVAL_MS = 5_000;
const SIGNER_TIMEOUT_MS = 5 * 60 * 1_000;

const SIGNER_POLICY_DESCRIPTIONS: Record<SignerPolicy, string> = {
  restricted: "authorize for all ACP transactions",
  "deny-all": "manual approval for all transactions",
  unrestricted: "no approval required",
};

// Step 1 of the signer flow: generate a local P-256 keypair (private key stays
// in the native keystore) and obtain the browser approval URL + requestId.
// Returns null on failure (error already emitted).
async function startAddSignerFlow(
  api: AgentApi,
  json: boolean,
  agent: Agent,
  open: boolean,
  policy: string = "restricted",
): Promise<{ publicKey: string; signerUrl: string; requestId: string } | null> {
  let publicKey: string;
  try {
    const result = generateNativeKeyPair();
    publicKey = result.publicKey;
  } catch (err) {
    outputError(
      json,
      `Failed to generate key pair: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  let signerUrl: string;
  let requestId: string;
  try {
    const res = await api.addSignerWithUrl(agent.id, policy);
    signerUrl = `${res.data.url}&publicKey=${publicKey}`;
    requestId = res.data.requestId;
  } catch (err) {
    outputError(
      json,
      `Failed to add signer: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  if (open) openBrowser(signerUrl);
  return { publicKey, signerUrl, requestId };
}

// Persist the public key + EVM walletId to config once a signer is approved.
function persistSigner(
  json: boolean,
  agent: Agent,
  publicKey: string,
): boolean {
  const evmProvider = agent.walletProviders.find(
    (wp) => (wp.chainType ?? "EVM") === "EVM",
  );
  if (!evmProvider?.metadata.walletId) {
    outputError(json, "EVM wallet provider not found for this agent.");
    return false;
  }
  setPublicKey(agent.walletAddress, publicKey);
  setWalletId(agent.walletAddress, evmProvider.metadata.walletId);
  return true;
}

type SignerCheck =
  | { state: "completed" }
  | { state: "pending" }
  | { state: "not_found" };

async function checkSignerStatus(
  api: AgentApi,
  agentId: string,
  requestId: string,
): Promise<SignerCheck> {
  try {
    const statusRes = await api.getSignerStatus(agentId, requestId);
    if (!statusRes.data.status) return { state: "not_found" };
    if (statusRes.data.status === "completed") return { state: "completed" };
    return { state: "pending" };
  } catch {
    // Transient polling error — treat as pending so the caller retries.
    return { state: "pending" };
  }
}

// Step 2 of the signer flow: poll until approved (or timeout), then persist.
async function completeAddSignerFlow(
  api: AgentApi,
  json: boolean,
  agent: Agent,
  publicKey: string,
  requestId: string,
  timeoutMs: number = SIGNER_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SIGNER_POLL_INTERVAL_MS));
    const check = await checkSignerStatus(api, agent.id, requestId);
    if (check.state === "not_found") {
      outputError(json, "Signer registration not found. Please try again.");
      return false;
    }
    if (check.state === "completed") {
      if (!json) console.log("Signer registration approved.");
      break;
    }
    if (Date.now() >= deadline) {
      outputError(json, "Signer registration timed out. Please try again.");
      return false;
    }
  }

  if (!persistSigner(json, agent, publicKey)) return false;

  if (json) {
    outputResult(json, { agentId: agent.id, agentName: agent.name });
  } else {
    console.log(`\nSigner added to ${agent.name} successfully!`);
  }
  return true;
}

// Original blocking flow, now composed from the split helpers. Used by
// `agent create`, `agent migrate`, and the default `add-signer` path.
async function runAddSignerFlow(
  api: AgentApi,
  json: boolean,
  agent: Agent,
  policy: string = "restricted",
): Promise<boolean> {
  const started = await startAddSignerFlow(api, json, agent, !json, policy);
  if (!started) return false;
  const { publicKey, signerUrl, requestId } = started;

  if (json) {
    outputResult(json, { signerUrl, expiresIn: "5 minutes" });
    emitSignerUrlToStderr(signerUrl);
  } else {
    console.log(`\nPublic Key: ${publicKey}`);
    console.log(
      `\nOpening browser to verify the public key and approve the signer...`,
    );
    console.log(`\n  ${signerUrl}\n`);
    console.log(`This link expires in 5 minutes.\n`);
    console.log(`Waiting for approval...`);
  }

  return completeAddSignerFlow(api, json, agent, publicKey, requestId);
}

async function runRegisterErc8004Flow(
  agentApi: AgentApi,
  json: boolean,
  agent: Agent,
  chainId: number,
  chainName: string,
): Promise<boolean> {
  let registerData: Erc8004RegisterTx;
  try {
    registerData = await agentApi.getErc8004RegisterData(agent.id, chainId);
  } catch (err) {
    outputError(
      json,
      `Failed to prepare ERC-8004 registration: ${
        err instanceof Error ? err.message : String(err)
      }`,
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
        typedDataArgs,
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
      }`,
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
      }`,
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
    .option(
      "--policy <policy>",
      "Authorization policy for the signer set up after creation — set this explicitly when using --signer. " +
        SIGNER_POLICIES.map(
          (p) => `${p}: ${SIGNER_POLICY_DESCRIPTIONS[p]}`,
        ).join("; ") +
        ". Or pass a custom policy id from `acp policy list`.",
      "restricted",
    )
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      // A preset name (SIGNER_POLICIES) or a custom policy id from
      // `acp policy list`. Both are forwarded verbatim to the approval URL.
      let policy = String(opts.policy).trim();
      const policyFromCli = cmd.getOptionValueSource("policy") === "cli";
      if (!policy) {
        outputError(
          json,
          new CliError(
            "Policy cannot be empty.",
            "VALIDATION_ERROR",
            `Use a preset (${SIGNER_POLICIES.join(
              ", ",
            )}) or a custom policy id from \`acp policy list\`.`,
          ),
        );
        return;
      }

      const { agentApi } = await getClient();

      let name: string = opts.name?.trim() ?? "";
      let description: string = opts.description?.trim() ?? "";
      // image is OPTIONAL. Treat any explicit --image (including empty) as
      // "caller opted out of the image prompt". Only fall back to prompting
      // for it when the flag was omitted AND we're in an interactive terminal.
      const imageFlagProvided = opts.image !== undefined;
      let image: string | undefined = opts.image?.trim() || undefined;

      const interactive = isTTY();

      // Non-interactive (agent harness, pipe, CI): never open a readline
      // prompt — it would hang with no stdin. Require the genuinely-mandatory
      // fields as flags and proceed with image left empty when it's omitted.
      if (!interactive) {
        if (!name) {
          outputError(
            json,
            new CliError(
              "Agent name is required",
              "VALIDATION_ERROR",
              'Pass --name in non-interactive mode, e.g. acp agent create --name "My Agent" --description "..." --json',
            ),
          );
          return;
        }
        if (!description) {
          outputError(
            json,
            new CliError(
              "Agent description is required",
              "VALIDATION_ERROR",
              'Pass --description in non-interactive mode. --image is OPTIONAL: omit it (or pass --image "") to create the agent without one.',
            ),
          );
          return;
        }
        // image stays undefined when --image is omitted — that's fine, it's optional.
      } else {
        const needsPrompt = !name || !description || !imageFlagProvided;
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

          if (!imageFlagProvided && rl) {
            const imageInput = (
              await prompt(
                rl,
                "Agent image URL (optional, press Enter to skip): ",
              )
            ).trim();
            if (imageInput) {
              image = imageInput;
            }
          }
        } finally {
          rl?.close();
        }
      }

      let created: Agent;
      try {
        created = await agentApi.create(name, description, image);
      } catch (err) {
        outputError(
          json,
          `Failed to create agent: ${
            err instanceof Error ? err.message : String(err)
          }`,
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
        const result = await agentApi.provisionEmailIdentity(created.id);
        emailAddress = result.emailAddress;
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
        `\n${c.green(`${created.name} has been created successfully!`)}\n`,
      );

      const tableRows: [string, string][] = [
        ["Name", created.name],
        ["Description", created.description],
        ["Wallet Address", created.walletAddress ?? "N/A"],
        ["Sol Wallet Address", created.solWalletAddress ?? "N/A"],
      ];
      if (emailAddress) tableRows.push(["Email", emailAddress]);
      printTable(tableRows);

      if (emailAddress) {
        console.log(
          `\n${c.green(
            "An email identity has been created for this agent:",
          )} ${c.cyan(emailAddress)}`,
        );
      } else if (emailError) {
        console.log(
          `\n${c.yellow("Could not provision email identity:")} ${emailError}`,
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
            resolve,
          ),
        );
        signerRl.close();
        setupSigner = answer.toLowerCase() === "y";
      }

      if (!setupSigner) {
        return;
      }

      if (!policyFromCli && isTTY()) {
        policy = await selectOption(
          "\nSelect the signer's policy:",
          SIGNER_POLICIES,
          (p) => `${p} — ${SIGNER_POLICY_DESCRIPTIONS[p]}`,
        );
      }

      const signerOk = await runAddSignerFlow(agentApi, json, created, policy);
      if (!signerOk) return;

      try {
        const acpAgent = await createAgentFromConfig();

        // Deploy for base chain only. Strict "true" check — IS_TESTNET=false
        // is truthy and would pick Base Sepolia, then silently skip
        // registration when the mainnet agent doesn't carry that chain.
        const baseChainId =
          process.env.IS_TESTNET === "true"
            ? viemChains.baseSepolia.id
            : viemChains.base.id;

        const chainIds = acpAgent.getSupportedChainIds();
        if (chainIds.length === 0) return;
        if (!chainIds.includes(baseChainId)) return;

        const client = acpAgent.getClient(baseChainId);
        if (!(client instanceof EvmAcpClient)) return;

        const chainById = new Map<number, string>(
          EVM_CHAINS.map((c) => [c.id, c.name]),
        );
        const chainName = chainById.get(baseChainId) ?? `Chain ${baseChainId}`;

        await runRegisterErc8004Flow(
          agentApi,
          json,
          created,
          baseChainId,
          chainName,
        );
      } catch (err) {
        outputError(
          json,
          `Failed to auto-register on ERC-8004: ${
            err instanceof Error ? err.message : String(err)
          }`,
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
              `  ${c.bold("Wallet:")}         ${c.dim(a.walletAddress)}`,
            );
            console.log(`  ${c.bold("Created:")}        ${c.dim(a.createdAt)}`);
          }
          console.log(
            `\n${c.dim(
              `Page ${meta.pagination.page} of ${meta.pagination.pageCount} (${meta.pagination.total} total)`,
            )}`,
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
          }`,
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
            }`,
          );
          return;
        }

        if (agents.length === 0) {
          outputError(json, "No agents found. Run `acp agent create` first.");
          return;
        }

        selected = await selectFromList(
          "Choose the agent to set as active:",
          agents,
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
    .description(
      "Add a signer to an agent. ALWAYS choose an explicit --policy that matches how much you want the " +
        "signer to be able to do on its own — don't rely on the default. " +
        `Policies: ${SIGNER_POLICIES.map(
          (p) => `${p} (${SIGNER_POLICY_DESCRIPTIONS[p]})`,
        ).join("; ")}.`,
    )
    .option("--agent-id <id>", "Agent ID")
    .option(
      "--policy <policy>",
      "Authorization policy for the signer — set this explicitly, don't depend on the default. " +
        SIGNER_POLICIES.map(
          (p) => `${p}: ${SIGNER_POLICY_DESCRIPTIONS[p]}`,
        ).join("; ") +
        ". Or pass a custom policy id from `acp policy list`.",
      "restricted",
    )
    .option(
      "--no-wait",
      "Agent-friendly: generate the key, print {signerUrl, requestId, publicKey} and exit immediately instead of blocking. Finish with `acp agent signer-status`.",
    )
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      // A preset name (SIGNER_POLICIES) or a custom policy id from
      // `acp policy list`. Both are forwarded verbatim to the approval URL.
      const policy = String(opts.policy).trim();
      if (!policy) {
        outputError(
          json,
          new CliError(
            "Policy cannot be empty.",
            "VALIDATION_ERROR",
            `Use a preset (${SIGNER_POLICIES.join(
              ", ",
            )}) or a custom policy id from \`acp policy list\`.`,
          ),
        );
        return;
      }

      const { agentApi } = await getClient();

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
            }`,
          );
          return;
        }

        if (agents.length === 0) {
          outputError(json, "No agents found.");
          return;
        }

        // selectFromList uses a raw-mode TTY picker; only safe when interactive.
        if (!isTTY()) {
          outputError(
            json,
            new CliError(
              "Multiple agents found and no TTY to choose from.",
              "NO_ACTIVE_AGENT",
              "Pass --agent-id <id> (see `acp agent list --json`), or set an active agent with `acp agent use`.",
            ),
          );
          return;
        }

        selected = await selectFromList(
          "Choose the agent you wish to add a new signer:",
          agents,
        );
      }

      if (!json) {
        console.log(`\nSelected: ${selected.name} ${selected.walletAddress}`);
      }

      // --no-wait: split flow. commander exposes the negated flag as opts.wait.
      if (opts.wait === false) {
        const started = await startAddSignerFlow(
          agentApi,
          json,
          selected,
          false,
          policy,
        );
        if (!started) return;
        outputResult(json, {
          signerUrl: started.signerUrl,
          requestId: started.requestId,
          publicKey: started.publicKey,
          agentId: selected.id,
          expiresIn: "5 minutes",
        });
        emitSignerUrlToStderr(started.signerUrl);
        return;
      }

      await runAddSignerFlow(agentApi, json, selected, policy);
    });

  agent
    .command("signer-status")
    .description(
      "Complete a split `add-signer --no-wait` flow: check approval and persist the signer. Returns {status:'pending'} until approved.",
    )
    .requiredOption(
      "--request-id <requestId>",
      "The requestId returned by `acp agent add-signer --no-wait`",
    )
    .requiredOption(
      "--public-key <publicKey>",
      "The publicKey returned by `acp agent add-signer --no-wait`",
    )
    .option("--agent-id <id>", "Agent ID (defaults to the active agent)")
    .option(
      "--wait",
      "Block and keep polling until approved or timeout, instead of a single check",
    )
    .option(
      "--timeout <seconds>",
      "With --wait, maximum seconds to wait (default 300)",
    )
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      const selected = await resolveAgent(agentApi, opts, json);
      if (!selected) {
        outputError(
          json,
          new CliError(
            "No agent resolved.",
            "NO_ACTIVE_AGENT",
            "Pass --agent-id <id> or set an active agent with `acp agent use`.",
          ),
        );
        return;
      }

      const requestId = String(opts.requestId);
      const publicKey = String(opts.publicKey);

      if (opts.wait) {
        const timeoutMs = opts.timeout
          ? Math.max(0, Number(opts.timeout) * 1000)
          : SIGNER_TIMEOUT_MS;
        await completeAddSignerFlow(
          agentApi,
          json,
          selected,
          publicKey,
          requestId,
          timeoutMs,
        );
        return;
      }

      const check = await checkSignerStatus(agentApi, selected.id, requestId);
      if (check.state === "not_found") {
        outputError(json, "Signer registration not found. Please try again.");
        return;
      }
      if (check.state === "pending") {
        outputResult(json, { status: "pending" });
        return;
      }
      if (!persistSigner(json, selected, publicKey)) return;
      outputResult(json, {
        status: "completed",
        agentId: selected.id,
        agentName: selected.name,
      });
    });

  agent
    .command("signer-policy")
    .description(
      "Show which wallet policy the active agent's signer is currently using.",
    )
    .option("--agent-id <id>", "Agent ID (defaults to the active agent)")
    .action(async (opts, cmd) => {
      const { agentApi, policyApi } = await getClient();
      const json = isJson(cmd);

      // Resolve the target agent (explicit --agent-id, else the active one).
      let agentId: string | undefined;
      let walletAddress: string | undefined;
      const selected = await resolveAgent(agentApi, opts, json);
      if (selected) {
        agentId = selected.id;
        walletAddress = selected.walletAddress;
      } else {
        walletAddress = getActiveWallet();
        if (!walletAddress) {
          outputError(
            json,
            new CliError(
              "No active agent set.",
              "NO_ACTIVE_AGENT",
              "Pass --agent-id <id> or set an active agent with `acp agent use`.",
            ),
          );
          return;
        }
        agentId = getAgentId(walletAddress);
        if (!agentId) {
          outputError(
            json,
            new CliError(
              "Agent ID not found for active wallet.",
              "NO_ACTIVE_AGENT",
              "Run `acp agent list` or `acp agent use` to populate it.",
            ),
          );
          return;
        }
      }

      let signers: WalletSigner[];
      try {
        const res = await policyApi.getWalletSigners(agentId);
        signers = res.data ?? [];
      } catch (err) {
        outputError(
          json,
          `Failed to fetch signers: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }

      // Build policyId -> human name from custom + global policies so we can
      // render names instead of opaque Privy ids. Best-effort: unresolved ids
      // fall back to the raw id.
      const nameById = new Map<string, string>();
      try {
        const [custom, global] = await Promise.all([
          policyApi.listPolicies({ limit: 100 }),
          policyApi.getGlobalPolicies(),
        ]);
        (custom.data ?? []).forEach((p: Policy) =>
          nameById.set(p.policyId, p.name),
        );
        (global.data ?? []).forEach((g: GlobalPolicy) =>
          nameById.set(g.policyId, g.name),
        );
      } catch {
        // Name resolution is a nicety; raw ids are still meaningful.
      }
      const resolve = (id: string) => nameById.get(id) ?? id;
      const describe = (s: WalletSigner) => {
        const ids = s.policy_ids ?? [];
        return ids.length === 0
          ? "No Policy (no approval required)"
          : ids.map(resolve).join(", ");
      };

      // Match the CLI's own signer key against each signer's authorization_keys.
      const publicKey = walletAddress ? getPublicKey(walletAddress) : undefined;
      const mine =
        (publicKey &&
          signers.find((s) =>
            (s.authorization_keys ?? []).some(
              (k) => k.public_key === publicKey,
            ),
          )) ||
        (signers.length === 1 ? signers[0] : undefined);

      if (mine) {
        if (json) {
          outputResult(json, {
            signerId: mine.id,
            policyIds: mine.policy_ids ?? [],
            policy: describe(mine),
          });
          return;
        }
        printTable([
          ["Signer", mine.display_name || mine.id],
          ["Policy", describe(mine)],
        ]);
        return;
      }

      // No confident match — show every signer's policy so the user can tell.
      if (json) {
        outputResult(json, {
          matched: false,
          signers: signers.map((s) => ({
            signerId: s.id,
            policyIds: s.policy_ids ?? [],
            policy: describe(s),
          })),
        });
        return;
      }
      if (signers.length === 0) {
        console.log("\nThis agent has no signers.\n");
        return;
      }
      console.log(
        `\n${c.yellow(
          "Could not match this CLI's signer key; showing all signers:",
        )}\n`,
      );
      printTable(signers.map((s) => [s.display_name || s.id, describe(s)]));
    });

  agent
    .command("set-signer-policy")
    .description(
      "Change or remove the active signer's policy (opens the dashboard — requires wallet-owner approval).",
    )
    .option("--agent-id <id>", "Agent ID (defaults to the active agent)")
    .option("--open", "Also open the dashboard in a browser")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      const { agentApi } = await getClient();
      const selected = await resolveAgent(agentApi, opts, json);
      const agentId =
        selected?.id ??
        (getActiveWallet() ? getAgentId(getActiveWallet()!) : undefined);
      const url = dashboardSignerPolicyUrl(agentId);

      if (json) {
        outputResult(json, {
          reason:
            "Changing a live signer's policy requires wallet-owner approval — open the url in a browser to continue.",
          url,
        });
        return;
      }
      console.log(
        `\n${c.yellow(
          "Changing a signer's policy requires wallet-owner approval.",
        )}\n` +
          `This signs with your wallet owner's session, which only the dashboard can do.\n\n` +
          `Open it here:\n\n    ${url}\n`,
      );
      if (opts.open === true) openBrowser(url);
    });

  agent
    .command("generate-signer-key")
    .description(
      "Generate a P-256 signer keypair locally. The private key stays in the keystore; the public key is printed for partner-side agent provisioning.",
    )
    .action((_opts, cmd) => {
      const json = isJson(cmd);
      try {
        const { publicKey } = generateNativeKeyPair();
        if (json) {
          outputResult(json, { publicKey });
        } else {
          console.log(`\nPublic Key: ${publicKey}\n`);
          console.log(
            "Send this public key to your partner provisioning API. Keep using this CLI on the same machine to retain access to the private key.",
          );
        }
      } catch (err) {
        outputError(
          json,
          `Failed to generate key pair: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });

  agent
    .command("link")
    .description(
      "Link an existing local signer keypair to an agent that was provisioned externally (e.g. by a partner backend).",
    )
    .requiredOption("--agent-id <id>", "Agent ID returned by the partner")
    .requiredOption(
      "--wallet <address>",
      "Agent's wallet address returned by the partner",
    )
    .requiredOption(
      "--signer-public-key <key>",
      "Public key previously emitted by `acp agent generate-signer-key`",
    )
    .option("--wallet-id <id>", "Privy wallet ID (optional)")
    .option(
      "--make-active",
      "Also set this agent as the currently active one",
      false,
    )
    .action((opts, cmd) => {
      const json = isJson(cmd);
      const wallet = String(opts.wallet);
      try {
        setPublicKey(wallet, String(opts.signerPublicKey));
        setAgentId(wallet, String(opts.agentId));
        if (opts.walletId) setWalletId(wallet, String(opts.walletId));
        if (opts.makeActive) setActiveWallet(wallet);
        outputResult(json, {
          success: true,
          agentId: String(opts.agentId),
          walletAddress: wallet,
          activeWallet: opts.makeActive ? wallet : getActiveWallet(),
        });
      } catch (err) {
        outputError(
          json,
          `Failed to link agent: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
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
            "Run `acp agent use` to set an active agent.",
          ),
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
            "Run `acp agent list` or `acp agent use` to populate it.",
          ),
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
          }`,
        );
        return;
      }

      if (json) {
        outputResult(json, agentData as unknown as Record<string, unknown>);
        return;
      }

      if (isTTY()) {
        const agentChains = agentData.chains ?? [];

        // Show Token/ERC-8004 status for the chains the agent can actually
        // tokenize/register on — the execution set createAgentFromConfig
        // serves, NOT createProviderAdapter's ERC20-sponsored trade superset,
        // which would print "Not tokenized" rows for chains (and testnets)
        // the agent never runs on.
        const supportedChains = (
          process.env.IS_TESTNET === "true"
            ? EVM_TESTNET_CHAINS
            : EVM_MAINNET_CHAINS
        ).map((c) => c.id);

        let tokenRows: [string, string][] = [];

        for (const chainId of supportedChains) {
          const selectedChain = agentChains.find(
            (ch) => ch.chainId === chainId,
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

        // Solana tokenization exists too; ERC-8004 does not (EVM-only
        // registry), so Solana gets only a Token row.
        if (agentData.solWalletAddress) {
          const solId = solanaChainId();
          const solChain = agentChains.find((ch) => ch.chainId === solId);
          tokenRows.push([
            "Token",
            `${solChain?.tokenAddress ?? "Not tokenized"} [${formatChainId(solId)}]`,
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
          }\t${agentData.id}`,
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
          "Provide at least one of --name, --description, or --image to update.",
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
            "Run `acp agent use` to set an active agent.",
          ),
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
            "Run `acp agent list` or `acp agent use` to populate it.",
          ),
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
          }`,
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
        `\n${c.green(`${updated.name} has been updated successfully!`)}\n`,
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
      "Anti-sniper protection: 0 (none), 1 (60s), 2 (98min)",
    )
    .option(
      "--prebuy <virtuals>",
      "Pre-buy amount in VIRTUAL tokens to spend at launch (e.g. 100 = 100 VIRTUAL)",
    )
    .option(
      "--acf",
      "Enable Agent Capital Formation (higher launch fee; enables dev allocation + sell wall)",
    )
    .option(
      "--60-days",
      "Enable 60 Days Experiment mode (reversible launch; 60-day cliff on pre-buy; Vibes tokenomics)",
    )
    .option(
      "--airdrop-percent <percent>",
      "Airdrop allocation to veVIRTUAL holders (0–5%, e.g. 1.25)",
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
            "Run `acp agent use` to set an active agent.",
          ),
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
            "Run `acp agent add-signer` to register a signing key before tokenizing.",
          ),
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
            "Run `acp agent list` or `acp agent use` to populate it.",
          ),
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
          }`,
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
              existingToken.chainId,
            )}.`,
            "ALREADY_TOKENIZED",
            "Each agent can only be tokenized once on a single chain.",
          ),
        );
        return;
      }

      // Step 3: Resolve chain options from the EVM & Solana provider
      let providerChains: { id: number; name: string }[];
      try {
        const provider = await createProviderAdapter();
        const supportedChainIds = new Set(
          await provider.getSupportedChainIds(),
        );

        // Offer only chains the EXECUTION path can serve: tokenization runs
        // through createAgentFromConfig, whose EVM client is built from
        // EVM_MAINNET_CHAINS / EVM_TESTNET_CHAINS — while createProviderAdapter
        // registers the wider ERC20-sponsored-gas set for trades (on mainnet
        // that superset includes Base Sepolia, which getClient() would then
        // reject after the user picked it).
        const executionChains =
          process.env.IS_TESTNET === "true"
            ? EVM_TESTNET_CHAINS
            : EVM_MAINNET_CHAINS;
        providerChains = executionChains
          .filter((c) => supportedChainIds.has(c.id))
          .map((c) => ({ id: c.id, name: c.name }));

        const hasSolana = selected.walletProviders.some(
          (wp) => wp.chainType === "SOLANA",
        );

        if (hasSolana) {
          providerChains.push({ id: solanaChainId(), name: "Solana" });
        }
      } catch (err) {
        outputError(
          json,
          `Failed to load provider chains: ${
            err instanceof Error ? err.message : String(err)
          }`,
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
          (c) => c.id.toString() === opts.chainId,
        );
        if (!match) {
          outputError(
            json,
            `Unsupported chain ID: ${opts.chainId}. Supported: ${providerChains
              .map((c) => `${c.name} (${c.id})`)
              .join(", ")}`,
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
          (chain) => chain.name,
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
          symbol = (
            await prompt(
              rl,
              "\nEnter token symbol, [only alphanumeric letters allowed]: ",
            )
          )
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
            `Invalid anti-sniper type: ${opts.antiSniper}. Must be 0, 1, or 2.`,
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
          (opt) => opt.label,
        );
        antiSniperTaxType = antiSniperChoice.value;
      }

      // Step 5: Pre-buy amount (VIRTUAL to spend at launch)
      let prebuyVirtualBaseUnit = 0n;
      if (opts.prebuy !== undefined) {
        const baseUnit = convertPrebuyVirtual(
          String(opts.prebuy),
          selectedChain.id,
        );
        if (baseUnit === null) {
          outputError(
            json,
            `Invalid --prebuy value: ${opts.prebuy}. Must be a non-negative number of VIRTUAL tokens.`,
          );
          return;
        }
        prebuyVirtualBaseUnit = baseUnit;
      } else if (opts.configure && !json) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const raw = await prompt(
            rl,
            "\nPre-buy amount in VIRTUAL tokens (blank to skip): ",
          );
          const base = convertPrebuyVirtual(raw, selectedChain.id);
          if (base === null) {
            outputError(
              json,
              `Invalid pre-buy value: ${raw}. Must be a non-negative number.`,
            );
            return;
          }
          prebuyVirtualBaseUnit = base;
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

      // Step 6b: 60 Days Experiment toggle + airdrop percent. Applies to every
      // venue — tokenizeOnSolana forwards both fields the same as tokenizeOnEvm,
      // so Solana launches must not skip the flag parsing/validation.
      let isProject60days = false;
      let airdropPercent = 0;

      {
        if (opts["60Days"]) {
          isProject60days = true;
        } else if (opts.configure && !json) {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          try {
            const raw = (
              await prompt(rl, "\nEnable 60 Days Experiment? (y/N): ")
            )
              .trim()
              .toLowerCase();
            isProject60days = raw === "y" || raw === "yes";
          } finally {
            rl.close();
          }
        }

        // Step 6c: Airdrop percent (0–5%)
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
              `Invalid --airdrop-percent value: ${opts.airdropPercent}. Must be a number between 0 and 5.`,
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
              "\nAirdrop percentage to veVIRTUAL holders (0–5, blank to skip): ",
            );
            const n = parseAirdropPercent(raw);
            if (n === null) {
              outputError(
                json,
                `Invalid airdrop percent: ${raw}. Must be a number between 0 and 5.`,
              );
              return;
            }
            airdropPercent = n;
          } finally {
            rl.close();
          }
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
              "\nMark as Robotics (Eastworld-eligible) launch? (y/N): ",
            )
          )
            .trim()
            .toLowerCase();
          isRobotics = raw === "y" || raw === "yes";
        } finally {
          rl.close();
        }
      }

      const onProgress = json ? undefined : (m: string) => console.log(m);

      let result: Awaited<ReturnType<typeof tokenizeOnEvm>>;
      try {
        const tokenizeParams = {
          agentId: selected.id,
          chainId: selectedChain.id,
          symbol,
          antiSniperTaxType,
          needAcf,
          isProject60days,
          airdropPercent,
          isRobotics,
          prebuyVirtualBaseUnit,
          walletAddress: selected.walletAddress,
          onProgress,
        };

        result = isSolanaChainId(selectedChain.id)
          ? await tokenizeOnSolana(agentApi, tokenizeParams, json)
          : await tokenizeOnEvm(agentApi, tokenizeParams, json);
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
        return;
      }

      if (!json) {
        console.log(
          `\nAgent ${selected.name} tokenized successfully as $${symbol}`,
        );
        console.log(`Transaction: ${result.txHash}`);
      } else {
        outputResult(json, {
          success: true,
          agentId: selected.id,
          agentName: selected.name,
          virtualId: result.virtualId,
          txHash: result.txHash,
          needAcf,
          isProject60days,
          airdropPercent,
          isRobotics,
          launchFee: result.launchFee,
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

      const supportedChainIds = acpAgent.getSupportedChainIds();
      if (supportedChainIds.length === 0) {
        outputError(json, "No supported chains configured for this agent.");
        return;
      }

      // The agent may also support Solana chains; ERC-8004 registration is
      // EVM-only, so pick the first chain whose client is an EvmAcpClient
      // instead of blindly taking supportedChainIds[0].
      const client = supportedChainIds
        .map((id) => acpAgent.getClient(id))
        .find((c): c is EvmAcpClient => c instanceof EvmAcpClient);

      if (!client) {
        outputError(
          json,
          "Only EVM chains are supported for ERC-8004 registration.",
        );
        return;
      }

      const provider = client.getProvider();
      const providerChainIds = new Set(await provider.getSupportedChainIds());
      const erc8004Chains = EVM_CHAINS.filter((c) =>
        providerChainIds.has(c.id),
      ).map((c) => ({ id: c.id, name: c.name }));

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
            }`,
          );
          return;
        }

        if (agents.length === 0) {
          outputError(json, "No agents found. Run `acp agent create` first.");
          return;
        }

        selected = await selectFromList(
          "Choose the agent to register on ERC-8004:",
          agents,
        );
      }

      // Step 2: Select chain
      let selectedChain: { id: number; name: string };
      if (opts.chainId) {
        const match = erc8004Chains.find(
          (c) => c.id.toString() === opts.chainId,
        );
        if (!match) {
          outputError(
            json,
            `Unsupported chain ID: ${opts.chainId}. Supported: ${erc8004Chains
              .map((c) => `${c.name} (${c.id})`)
              .join(", ")}`,
          );
          return;
        }
        selectedChain = match;
      } else {
        selectedChain = await selectOption(
          "\nChoose a chain to register on:",
          erc8004Chains,
          (chain) => chain.name,
        );
      }

      // Step 3: Run ERC-8004 registration flow
      const success = await runRegisterErc8004Flow(
        agentApi,
        json,
        selected,
        selectedChain.id,
        selectedChain.name,
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
      "Migrate a legacy agent to ACP SDK 2.0, or complete an in-progress migration",
    )
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);

      // Complete agent migration flow
      if (opts.complete) {
        if (!opts.agentId) {
          outputError(
            json,
            "Please provide the agent ID to complete migration.",
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
            }`,
          );
          return;
        }

        const match = legacyAgents.find((a) => a.id === numericId);
        if (!match) {
          outputError(
            json,
            `Agent with ID ${numericId} not found in legacy agents.`,
          );
          return;
        }

        const startMigrationCommand = `acp agent migrate --agent-id ${match.id}`;

        switch (match.migrationStatus) {
          case MigrationStatus.PENDING:
            outputError(
              json,
              `Agent "${match.name}" is not yet created. Run ${startMigrationCommand} to start migrating the agent.`,
            );
            return;
          case MigrationStatus.COMPLETED:
            outputError(
              json,
              `Agent "${match.name}" has already been migrated.`,
            );
            return;
          case MigrationStatus.IN_PROGRESS:
            break;
          default:
            outputError(
              json,
              `Agent "${match.name}" has an unexpected migration status: ${match.migrationStatus}.`,
            );
            return;
        }

        const agents = await agentApi.list();
        const selectedAgent = agents.data.find((a) =>
          a.chains.find((c) => c.acpV2AgentId === numericId),
        );

        if (!selectedAgent) {
          outputError(
            json,
            `No migrated agent found linked to legacy agent ID ${numericId}.`,
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
            `\nAgent "${match.name}" has been migrated successfully! This is your active agent now.`,
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
          }`,
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
            `Agent with ID ${opts.agentId} not found in legacy agents.`,
          );
          return;
        }
        selected = found;
      } else {
        selected = await selectOption(
          "Select an agent to migrate:",
          legacyAgents,
          (a) =>
            `${a.name} ${maskAddress(a.walletAddress)} [${a.migrationStatus}]`,
        );
      }

      const completeMigrationCommand = `acp agent migrate --agent-id ${selected.id} --complete`;

      switch (selected.migrationStatus) {
        case MigrationStatus.IN_PROGRESS:
          outputError(
            json,
            `Agent "${selected.name}" migration is in progress. Run ${completeMigrationCommand} to complete the migration.`,
          );
          return;
        case MigrationStatus.COMPLETED:
          outputError(
            json,
            `Agent "${selected.name}" has already been migrated.`,
          );
          return;
        case MigrationStatus.PENDING:
          break;
        default:
          outputError(
            json,
            `Agent "${selected.name}" has an unexpected migration status: ${selected.migrationStatus}.`,
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
          }`,
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
          `Your agent has been created. ${instructions}\n\nWhen you are ready to activate this agent, run:\n\n  ${completeMigrationCommand}`,
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
