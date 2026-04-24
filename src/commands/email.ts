import * as readline from "readline";
import type { Command } from "commander";
import { isJson, outputResult, outputError, isTTY } from "../lib/output";
import { c } from "../lib/color";
import { getClient } from "../lib/api/client";
import { prompt, printTable } from "../lib/prompt";
import { getActiveAgentId } from "../lib/activeAgent";
import type { EmailMessage } from "../lib/api/agent";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function printMessage(msg: EmailMessage): void {
  printTable([
    ["ID", msg.id],
    ["Thread", msg.threadId],
    ["Direction", msg.direction],
    ["From", msg.from],
    ["To", msg.to.join(", ")],
    ["Subject", msg.subject],
    ["Preview", msg.preview],
    ["Received", formatDate(msg.receivedAt)],
    ["Read", msg.isRead ? "Yes" : "No"],
  ]);
}

export function registerEmailCommands(program: Command): void {
  const email = program
    .command("email")
    .description("Manage agent email");

  // WHOAMI — mirrors the existing `agent whoami` / `card whoami` convention.
  email
    .command("whoami")
    .description("Show the provisioned email identity for the active agent")
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const identity = await agentApi.getEmailIdentity(agentId);
        if (json) {
          outputResult(
            json,
            (identity ?? {}) as unknown as Record<string, unknown>
          );
        } else if (!identity) {
          console.log(
            `No email identity provisioned. Run ${c.cyan("acp email provision")} to create one.`
          );
        } else {
          printTable([
            ["Agent ID", identity.agentId],
            ["Email", identity.emailAddress],
            ["Status", identity.status],
            ["Created", new Date(identity.createdAt).toLocaleString()],
          ]);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // PROVISION
  email
    .command("provision")
    .description("Provision a new email identity for the active agent")
    .option("--display-name <name>", "Display name for the email identity")
    .option("--local-part <localPart>", "Local part of the email address (before @)")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      let rl: readline.Interface | undefined;

      try {
        if (!opts.displayName || !opts.localPart) {
          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
        }

        const displayName =
          opts.displayName ??
          (await prompt(rl!, "Display name: ")).trim();
        if (!displayName) {
          outputError(json, "Display name cannot be empty.");
          return;
        }

        const localPart =
          opts.localPart ??
          (await prompt(rl!, "Local part (before @): ")).trim();
        if (!localPart) {
          outputError(json, "Local part cannot be empty.");
          return;
        }

        const result = await agentApi.provisionEmailIdentity(
          agentId,
          displayName,
          localPart
        );

        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          console.log(
            `\n${c.green("Email identity provisioned!")} Address: ${c.cyan(result.emailAddress)}`
          );
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      } finally {
        rl?.close();
      }
    });

  // INBOX
  email
    .command("inbox")
    .description("View inbox messages for the active agent")
    .option("--folder <folder>", "Folder to view")
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--limit <number>", "Number of messages (1-100)")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
        const inbox = await agentApi.getEmailInbox(agentId, {
          folder: opts.folder,
          cursor: opts.cursor,
          limit,
        });

        if (json) {
          process.stdout.write(JSON.stringify(inbox) + "\n");
          return;
        }

        if (inbox.messages.length === 0) {
          console.log("No messages found.");
          return;
        }

        if (isTTY()) {
          for (const msg of inbox.messages) {
            printMessage(msg);
            console.log();
          }
          if (inbox.nextCursor) {
            console.log(c.dim(`Next cursor: ${inbox.nextCursor}`));
          }
        } else {
          console.log("ID\tFROM\tSUBJECT\tDATE\tREAD");
          for (const msg of inbox.messages) {
            console.log(
              `${msg.id}\t${msg.from}\t${msg.subject}\t${formatDate(msg.receivedAt)}\t${msg.isRead ? "Y" : "N"}`
            );
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // COMPOSE
  email
    .command("compose")
    .description("Compose and send an email")
    .option("--to <email>", "Recipient email address")
    .option("--subject <subject>", "Email subject")
    .option("--body <text>", "Email body (plain text)")
    .option("--html-body <html>", "Email body (HTML)")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      let rl: readline.Interface | undefined;

      try {
        if (!opts.to || !opts.subject || !opts.body) {
          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
        }

        const to = opts.to ?? (await prompt(rl!, "To: ")).trim();
        if (!to) {
          outputError(json, "Recipient cannot be empty.");
          return;
        }

        const subject =
          opts.subject ?? (await prompt(rl!, "Subject: ")).trim();
        if (!subject) {
          outputError(json, "Subject cannot be empty.");
          return;
        }

        const textBody =
          opts.body ?? (await prompt(rl!, "Body: ")).trim();
        if (!textBody) {
          outputError(json, "Body cannot be empty.");
          return;
        }

        const payload: { to: string; subject: string; textBody: string; htmlBody?: string } = {
          to,
          subject,
          textBody,
        };
        if (opts.htmlBody) payload.htmlBody = opts.htmlBody;

        const result = await agentApi.composeEmail(agentId, payload);

        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          console.log(`\n${c.green("Email sent!")}`);
          printTable([
            ["Message ID", result.messageId],
            ["Thread ID", result.threadId],
          ]);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      } finally {
        rl?.close();
      }
    });

  // SEARCH
  email
    .command("search")
    .description("Search emails")
    .requiredOption("--query <query>", "Search query")
    .action(async (opts, cmd) => {
      const query: string = opts.query;
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const result = await agentApi.searchEmails(agentId, query);

        if (json) {
          process.stdout.write(JSON.stringify(result) + "\n");
          return;
        }

        if (result.messages.length === 0) {
          console.log("No messages found.");
          return;
        }

        if (isTTY()) {
          for (const msg of result.messages) {
            printMessage(msg);
            console.log();
          }
        } else {
          console.log("ID\tFROM\tSUBJECT\tDATE");
          for (const msg of result.messages) {
            console.log(
              `${msg.id}\t${msg.from}\t${msg.subject}\t${formatDate(msg.receivedAt)}`
            );
          }
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // THREAD
  email
    .command("thread")
    .description("View an email thread")
    .requiredOption("--thread-id <id>", "Thread ID")
    .action(async (opts, cmd) => {
      const threadId: string = opts.threadId;
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const thread = await agentApi.getEmailThread(agentId, threadId);

        if (json) {
          process.stdout.write(JSON.stringify(thread) + "\n");
          return;
        }

        console.log(`${c.bold("Thread:")} ${thread.subject} (${thread.status})\n`);

        for (const msg of thread.messages) {
          const dir = msg.direction === "inbound" ? c.cyan("IN") : c.yellow("OUT");
          console.log(`${dir} ${c.dim(formatDate(msg.receivedAt))}`);
          console.log(`  From: ${msg.from}`);
          console.log(`  To: ${msg.to.join(", ")}`);
          console.log(`  ${msg.textBody.slice(0, 200)}${msg.textBody.length > 200 ? "..." : ""}`);
          if (msg.attachments.length > 0) {
            console.log(
              `  Attachments: ${msg.attachments.map((a) => `${a.filename} (${a.mimeType})`).join(", ")}`
            );
          }
          console.log();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // REPLY
  email
    .command("reply")
    .description("Reply to an email thread")
    .requiredOption("--thread-id <id>", "Thread ID")
    .option("--body <text>", "Reply body (plain text)")
    .option("--html-body <html>", "Reply body (HTML)")
    .action(async (opts, cmd) => {
      const threadId: string = opts.threadId;
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      let rl: readline.Interface | undefined;

      try {
        let textBody: string;
        if (opts.body) {
          textBody = opts.body;
        } else {
          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          textBody = (await prompt(rl, "Reply body: ")).trim();
          if (!textBody) {
            outputError(json, "Reply body cannot be empty.");
            return;
          }
        }

        const payload: { textBody: string; htmlBody?: string } = { textBody };
        if (opts.htmlBody) payload.htmlBody = opts.htmlBody;

        const result = await agentApi.replyToEmailThread(agentId, threadId, payload);

        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          console.log(`${c.green("Reply sent!")} Message ID: ${result.messageId}`);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      } finally {
        rl?.close();
      }
    });

  // EXTRACT OTP
  email
    .command("extract-otp")
    .description("Extract OTP code from an email message")
    .requiredOption("--message-id <id>", "Message ID")
    .action(async (opts, cmd) => {
      const messageId: string = opts.messageId;
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const result = await agentApi.extractOtp(agentId, messageId);

        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else if (result.otp) {
          console.log(`OTP: ${c.bold(result.otp)}`);
        } else {
          console.log("No OTP found in this message.");
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // EXTRACT LINKS
  email
    .command("extract-links")
    .description("Extract links from an email message")
    .requiredOption("--message-id <id>", "Message ID")
    .action(async (opts, cmd) => {
      const messageId: string = opts.messageId;
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const result = await agentApi.extractLinks(agentId, messageId);

        if (json) {
          process.stdout.write(JSON.stringify(result) + "\n");
          return;
        }

        if (result.links.length === 0) {
          console.log("No links found in this message.");
          return;
        }

        for (const link of result.links) {
          printTable([
            ["URL", link.url],
            ["Text", link.text],
            ["Category", link.category],
          ]);
          console.log();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
