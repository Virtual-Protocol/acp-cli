import * as readline from "readline";
import type { Command } from "commander";
import {
  isJson,
  outputResult,
  outputError,
  formatDate,
} from "../lib/output";
import { c } from "../lib/color";
import { getClient } from "../lib/api/client";
import { prompt, printTable } from "../lib/prompt";
import { getActiveAgentId } from "../lib/activeAgent";
import { CliError } from "../lib/errors";
import {
  AgentPhoneClient,
  type AgentPhoneAgent,
  type AgentPhoneCall,
  type AgentPhoneConversation,
  type AgentPhoneMessage,
  type AgentPhoneNumber,
  type AgentPhoneTranscript,
} from "../lib/api/agentphone";
import {
  getPhoneMapping,
  setPhoneMapping,
  type PhoneMapping,
} from "../lib/phoneConfig";

function newClient(): AgentPhoneClient {
  return new AgentPhoneClient();
}

function reportError(json: boolean, err: unknown): void {
  if (err instanceof Error) outputError(json, err);
  else outputError(json, String(err));
}

async function resolveAgentphoneAgentId(
  ap: AgentPhoneClient,
  acpAgentId: string,
  opts: {
    voiceMode: "webhook" | "hosted";
    webhookUrl?: string;
    systemPrompt?: string;
  }
): Promise<{ agentphoneAgentId: string; mapping: PhoneMapping }> {
  const existing = getPhoneMapping(acpAgentId);
  if (existing) {
    return { agentphoneAgentId: existing.agentphoneAgentId, mapping: existing };
  }

  // Lazy-create: look up the ACP agent's name to use as the AgentPhone
  // persona name, so the personas are recognizable in the AgentPhone
  // dashboard.
  const { agentApi } = await getClient();
  const acpAgent = await agentApi.getById(acpAgentId);

  const created = await ap.createAgent({
    name: acpAgent.name,
    voiceMode: opts.voiceMode,
    webhookUrl: opts.webhookUrl,
    systemPrompt: opts.systemPrompt,
  });

  const mapping: PhoneMapping = {
    agentphoneAgentId: created.id,
    voiceMode: opts.voiceMode,
    webhookUrl: opts.webhookUrl,
    createdAt: new Date().toISOString(),
  };
  setPhoneMapping(acpAgentId, mapping);
  return { agentphoneAgentId: created.id, mapping };
}

function printNumber(n: AgentPhoneNumber): void {
  printTable([
    ["Number ID", n.id],
    ["E.164", n.phoneNumber],
    ["Country", n.country ?? "—"],
    ["Status", n.status ?? "—"],
    ["Attached agent", n.agentId ?? "—"],
    ["Created", n.createdAt ? formatDate(n.createdAt) : "—"],
  ]);
}

function printConversation(conv: AgentPhoneConversation): void {
  printTable([
    ["ID", conv.id],
    ["Participant", conv.participant ?? "—"],
    ["Messages", conv.messageCount !== undefined ? String(conv.messageCount) : "—"],
    ["Last msg", conv.lastMessageAt ? formatDate(conv.lastMessageAt) : "—"],
    ["Preview", conv.preview ?? "—"],
  ]);
}

function printMessage(msg: AgentPhoneMessage): void {
  const dir =
    msg.direction === "inbound"
      ? c.cyan("IN")
      : msg.direction === "outbound"
        ? c.yellow("OUT")
        : msg.direction ?? "—";
  console.log(`${dir} ${c.dim(msg.createdAt ? formatDate(msg.createdAt) : "")}`);
  console.log(`  From: ${msg.from ?? "—"}`);
  console.log(`  To:   ${msg.to ?? "—"}`);
  console.log(`  ${msg.body ?? ""}`);
}

function printCall(call: AgentPhoneCall): void {
  printTable([
    ["Call ID", call.id],
    ["From", call.fromNumber ?? "—"],
    ["To", call.toNumber ?? "—"],
    ["Status", call.status ?? "—"],
    ["Duration", call.durationSeconds !== undefined ? `${call.durationSeconds}s` : "—"],
    ["Created", call.createdAt ? formatDate(call.createdAt) : "—"],
  ]);
}

function printTranscript(t: AgentPhoneTranscript): void {
  if (!t.turns?.length) {
    console.log("No transcript turns.");
    return;
  }
  for (const turn of t.turns) {
    const label =
      turn.role === "user"
        ? c.cyan("CALLER")
        : turn.role === "agent"
          ? c.yellow("AGENT")
          : turn.role.toUpperCase();
    const at = turn.at ? c.dim(` ${formatDate(turn.at)}`) : "";
    console.log(`${label}${at}`);
    console.log(`  ${turn.text}`);
  }
}

async function confirmYes(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await prompt(rl, `${message} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export function registerPhoneCommands(program: Command): void {
  const phone = program
    .command("phone")
    .description(
      "Manage AgentPhone (https://agentphone.ai) numbers, SMS, and voice calls for the active agent. Requires AGENTPHONE_API_KEY."
    );

  // WHOAMI
  phone
    .command("whoami")
    .description("Show the AgentPhone persona linked to the active ACP agent")
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);
      const acpAgentId = getActiveAgentId(json);
      if (!acpAgentId) return;

      const mapping = getPhoneMapping(acpAgentId);
      if (!mapping) {
        if (json) {
          outputResult(json, { linked: false, acpAgentId });
        } else {
          console.log(
            `No AgentPhone persona linked to this agent yet. Run ${c.cyan("acp phone provision")} to create one.`
          );
        }
        return;
      }

      try {
        const ap = newClient();
        const persona = await ap.getAgent(mapping.agentphoneAgentId);
        if (json) {
          outputResult(json, {
            linked: true,
            acpAgentId,
            mapping,
            persona: persona as unknown as Record<string, unknown>,
          });
        } else {
          printTable([
            ["ACP agent", acpAgentId],
            ["AgentPhone agent", persona.id],
            ["Name", persona.name],
            ["Voice mode", persona.voiceMode],
            ["Webhook URL", persona.webhookUrl ?? "—"],
            ["Linked at", formatDate(mapping.createdAt)],
          ]);
          if (persona.numbers && persona.numbers.length > 0) {
            console.log("\nAttached numbers:");
            for (const n of persona.numbers) {
              printNumber(n);
              console.log();
            }
          } else {
            console.log(`\nNo numbers attached. Run ${c.cyan("acp phone provision")}.`);
          }
        }
      } catch (err) {
        reportError(json, err);
      }
    });

  // PROVISION
  phone
    .command("provision")
    .description(
      "Buy a phone number and attach it to the active ACP agent. Creates the AgentPhone persona on first use."
    )
    .option("--area-code <code>", "Preferred area code (e.g. 415)")
    .option("--country <iso>", "ISO country code", "US")
    .option(
      "--voice-mode <mode>",
      "Voice mode: webhook | hosted (default: webhook)",
      "webhook"
    )
    .option(
      "--webhook-url <url>",
      "Webhook URL to receive call transcripts (required for voice-mode=webhook)"
    )
    .option(
      "--system-prompt <text>",
      "System prompt (used when voice-mode=hosted)"
    )
    .option("--yes", "Skip the monthly-cost confirmation prompt")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      const acpAgentId = getActiveAgentId(json);
      if (!acpAgentId) return;

      const voiceMode = opts.voiceMode as "webhook" | "hosted";
      if (voiceMode !== "webhook" && voiceMode !== "hosted") {
        outputError(
          json,
          new CliError(
            `Invalid --voice-mode: ${opts.voiceMode}`,
            "VALIDATION_ERROR",
            "Use either 'webhook' or 'hosted'."
          )
        );
        return;
      }
      if (voiceMode === "webhook" && !opts.webhookUrl && !getPhoneMapping(acpAgentId)?.webhookUrl) {
        outputError(
          json,
          new CliError(
            "--webhook-url is required for voice-mode=webhook on first provision.",
            "VALIDATION_ERROR",
            "Pass --webhook-url <url>, or use --voice-mode hosted."
          )
        );
        return;
      }

      if (!opts.yes && !json) {
        const ok = await confirmYes(
          "Provisioning a phone number costs $3.00/month plus per-minute SMS/voice usage. Continue?"
        );
        if (!ok) {
          console.log("Aborted.");
          return;
        }
      }

      try {
        const ap = newClient();
        const { agentphoneAgentId } = await resolveAgentphoneAgentId(
          ap,
          acpAgentId,
          {
            voiceMode,
            webhookUrl: opts.webhookUrl,
            systemPrompt: opts.systemPrompt,
          }
        );

        const number = await ap.createNumber({
          country: opts.country,
          areaCode: opts.areaCode,
          agentId: agentphoneAgentId,
        });

        if (json) {
          outputResult(json, {
            acpAgentId,
            agentphoneAgentId,
            number: number as unknown as Record<string, unknown>,
          });
        } else {
          console.log(
            `\n${c.green("Phone number provisioned!")} ${c.cyan(number.phoneNumber)}`
          );
          printNumber(number);
        }
      } catch (err) {
        reportError(json, err);
      }
    });

  // NUMBERS
  phone
    .command("numbers")
    .description("List all phone numbers on the AgentPhone account")
    .option("--limit <number>", "Page size (1-100)")
    .option("--offset <number>", "Offset (default 0)")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const ap = newClient();
        const numbers = await ap.listNumbers({
          limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
          offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
        });
        if (json) {
          process.stdout.write(JSON.stringify({ numbers }) + "\n");
          return;
        }
        if (numbers.length === 0) {
          console.log("No numbers on this account.");
          return;
        }
        for (const n of numbers) {
          printNumber(n);
          console.log();
        }
      } catch (err) {
        reportError(json, err);
      }
    });

  // ATTACH
  phone
    .command("attach")
    .description("Attach an existing AgentPhone number to the active ACP agent")
    .argument("<numberId>", "Number ID (e.g. num_xyz...)")
    .action(async (numberId: string, _opts, cmd) => {
      const json = isJson(cmd);
      const acpAgentId = getActiveAgentId(json);
      if (!acpAgentId) return;

      try {
        const ap = newClient();
        const { agentphoneAgentId } = await resolveAgentphoneAgentId(
          ap,
          acpAgentId,
          { voiceMode: "webhook" }
        );
        const result = await ap.attachNumber(agentphoneAgentId, numberId);
        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          console.log(`${c.green("Attached.")}`);
          printNumber(result);
        }
      } catch (err) {
        reportError(json, err);
      }
    });

  // SMS group
  const sms = phone.command("sms").description("SMS subcommands");

  sms
    .command("send")
    .description("Send an SMS from one of the active agent's numbers")
    .requiredOption("--to <e164>", "Recipient phone number (E.164)")
    .requiredOption("--body <text>", "Message body")
    .option(
      "--from <e164>",
      "Sender E.164 (defaults to the first attached number)"
    )
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      const acpAgentId = getActiveAgentId(json);
      if (!acpAgentId) return;

      const mapping = getPhoneMapping(acpAgentId);
      if (!mapping) {
        outputError(
          json,
          new CliError(
            "No AgentPhone persona linked.",
            "NO_ACTIVE_AGENT",
            "Run `acp phone provision` first."
          )
        );
        return;
      }

      try {
        const ap = newClient();
        let from: string | undefined = opts.from;
        if (!from) {
          const persona = await ap.getAgent(mapping.agentphoneAgentId);
          from = persona.numbers?.[0]?.phoneNumber;
          if (!from) {
            outputError(
              json,
              new CliError(
                "No numbers attached to this agent.",
                "VALIDATION_ERROR",
                "Run `acp phone provision` or pass --from."
              )
            );
            return;
          }
        }
        const result = await ap.sendMessage({
          from,
          to: opts.to,
          body: opts.body,
        });
        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          console.log(`${c.green("Sent.")} Message ID: ${result.id}`);
        }
      } catch (err) {
        reportError(json, err);
      }
    });

  sms
    .command("inbox")
    .description("List SMS conversations on this AgentPhone account")
    .option("--limit <number>", "Page size", "20")
    .option("--offset <number>", "Offset", "0")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const ap = newClient();
        const convs = await ap.listConversations({
          limit: parseInt(opts.limit, 10),
          offset: parseInt(opts.offset, 10),
        });
        if (json) {
          process.stdout.write(JSON.stringify({ conversations: convs }) + "\n");
          return;
        }
        if (convs.length === 0) {
          console.log("No conversations.");
          return;
        }
        for (const conv of convs) {
          printConversation(conv);
          console.log();
        }
      } catch (err) {
        reportError(json, err);
      }
    });

  sms
    .command("thread")
    .description("Show messages in a conversation")
    .argument("<conversationId>", "Conversation ID")
    .option("--limit <number>", "Page size", "50")
    .option("--offset <number>", "Offset", "0")
    .action(async (conversationId: string, opts, cmd) => {
      const json = isJson(cmd);
      try {
        const ap = newClient();
        const messages = await ap.listMessages(conversationId, {
          limit: parseInt(opts.limit, 10),
          offset: parseInt(opts.offset, 10),
        });
        if (json) {
          process.stdout.write(JSON.stringify({ messages }) + "\n");
          return;
        }
        if (messages.length === 0) {
          console.log("No messages.");
          return;
        }
        for (const msg of messages) {
          printMessage(msg);
          console.log();
        }
      } catch (err) {
        reportError(json, err);
      }
    });

  // CALL (singular: initiate)
  phone
    .command("call")
    .description("Place an outbound voice call from the active agent")
    .requiredOption("--to <e164>", "Destination number (E.164)")
    .option(
      "--from-number-id <id>",
      "Source number ID (defaults to the agent's first number)"
    )
    .option("--greeting <text>", "Initial spoken greeting")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      const acpAgentId = getActiveAgentId(json);
      if (!acpAgentId) return;

      const mapping = getPhoneMapping(acpAgentId);
      if (!mapping) {
        outputError(
          json,
          new CliError(
            "No AgentPhone persona linked.",
            "NO_ACTIVE_AGENT",
            "Run `acp phone provision` first."
          )
        );
        return;
      }

      try {
        const ap = newClient();
        const call = await ap.createCall({
          agentId: mapping.agentphoneAgentId,
          toNumber: opts.to,
          fromNumberId: opts.fromNumberId,
          greeting: opts.greeting,
        });
        if (json) {
          outputResult(json, call as unknown as Record<string, unknown>);
        } else {
          console.log(`${c.green("Call initiated.")}`);
          printCall(call);
        }
      } catch (err) {
        reportError(json, err);
      }
    });

  // CALLS group (plural: list / transcript)
  const calls = phone.command("calls").description("Call history subcommands");

  calls
    .command("list")
    .description("List recent calls")
    .option("--limit <number>", "Page size", "20")
    .option("--offset <number>", "Offset", "0")
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      try {
        const ap = newClient();
        const list = await ap.listCalls({
          limit: parseInt(opts.limit, 10),
          offset: parseInt(opts.offset, 10),
        });
        if (json) {
          process.stdout.write(JSON.stringify({ calls: list }) + "\n");
          return;
        }
        if (list.length === 0) {
          console.log("No calls.");
          return;
        }
        for (const call of list) {
          printCall(call);
          console.log();
        }
      } catch (err) {
        reportError(json, err);
      }
    });

  calls
    .command("transcript")
    .description("Fetch the full transcript for a completed call")
    .argument("<callId>", "Call ID")
    .action(async (callId: string, _opts, cmd) => {
      const json = isJson(cmd);
      try {
        const ap = newClient();
        const transcript = await ap.getTranscript(callId);
        if (json) {
          process.stdout.write(JSON.stringify(transcript) + "\n");
          return;
        }
        printTranscript(transcript);
      } catch (err) {
        reportError(json, err);
      }
    });
}
