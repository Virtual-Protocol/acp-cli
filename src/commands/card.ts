import * as readline from "readline";
import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output";
import { c } from "../lib/color";
import { getClient } from "../lib/api/client";
import { prompt, printTable } from "../lib/prompt";
import { getActiveAgentId } from "../lib/activeAgent";
import type {
  CardProfileResponse,
  NextStep,
  SpendRequest,
} from "../lib/api/agent";

// ── Formatters ──────────────────────────────────────────────────────

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// nextStep is the server's authoritative hint for what to do next. Always
// surface it (unless null = nothing to do) so agents can self-advance.
function printNextStep(next: NextStep | null | undefined): void {
  if (!next) return;
  console.log(`\n${c.dim("→")} ${c.bold("Next:")} ${next.hint}`);
  console.log(`  ${c.dim(next.endpoint)}`);
}

function printProfile(p: CardProfileResponse): void {
  printTable([
    ["Email", p.email],
    ["First Name", p.firstName ?? c.dim("(not set)")],
    ["Last Name", p.lastName ?? c.dim("(not set)")],
    ["Phone", p.phoneNumber ?? c.dim("(not set)")],
    [
      "Payment Method",
      p.paymentMethod
        ? `${p.paymentMethod.brand} •••• ${p.paymentMethod.last4} (${p.paymentMethod.expMonth}/${p.paymentMethod.expYear})`
        : c.dim("(not set)"),
    ],
    ["Spend Limit", formatCents(p.spendLimitCents)],
    ["Locked", p.locked ? c.yellow("Yes") : "No"],
  ]);
}

function printSpendRequest(r: SpendRequest): void {
  const rows: [string, string][] = [
    ["Request ID", r.id],
    ["Amount", formatCents(r.amountCents)],
    ["Status", r.status],
    ["Created", formatDate(r.createdAt)],
    ["Expires", formatDate(r.expiresAt)],
  ];
  if (r.issuedAt) rows.push(["Issued", formatDate(r.issuedAt)]);
  if (r.capturedAmountCents !== undefined && r.capturedAmountCents !== null) {
    rows.push(["Captured", formatCents(r.capturedAmountCents)]);
  }
  if (r.capturedAt) rows.push(["Captured At", formatDate(r.capturedAt)]);
  if (r.last4) rows.push(["Last 4", r.last4]);
  if (r.pan) rows.push(["PAN", r.pan]);
  if (r.cvv) rows.push(["CVV", r.cvv]);
  if (r.expiryMonth !== undefined && r.expiryYear !== undefined) {
    rows.push(["Expiry", `${r.expiryMonth}/${r.expiryYear}`]);
  }
  if (r.zip) rows.push(["ZIP", r.zip]);
  if (r.cardholderName) rows.push(["Cardholder", r.cardholderName]);
  printTable(rows);
}

// ── Registration ────────────────────────────────────────────────────

export function registerCardCommands(program: Command): void {
  const card = program
    .command("card")
    .description(
      "Manage agent virtual cards (signup → profile → payment method → limit → issue)"
    );

  // -- Auth --

  card
    .command("signup")
    .description("Sign up for agentcard.ai via magic link")
    .option("--email <email>", "Email address for signup")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      let rl: readline.Interface | undefined;
      try {
        let email: string;
        if (opts.email) {
          email = opts.email.trim();
        } else {
          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          email = (await prompt(rl, "Email: ")).trim();
        }
        if (!email) {
          outputError(json, "Email cannot be empty.");
          return;
        }

        const result = await agentApi.cardSignup(agentId, email);

        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          console.log(`\n${c.green("Magic link sent!")} Check your email.`);
          console.log(`State: ${result.state}`);
          console.log(
            `\nPoll with: ${c.cyan(`acp card signup-poll --state ${result.state}`)}`
          );
          printNextStep(result.nextStep);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      } finally {
        rl?.close();
      }
    });

  card
    .command("signup-poll")
    .description("Poll for magic link signup completion")
    .requiredOption("--state <state>", "State token from signup")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const result = await agentApi.cardSignupPoll(agentId, opts.state);

        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else if (result.done) {
          console.log(`${c.green("Signup complete!")} Email: ${result.email}`);
          printNextStep(result.nextStep);
        } else {
          console.log("Signup not yet completed. Try again shortly.");
          printNextStep(result.nextStep);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  card
    .command("whoami")
    .description("Get card account email and verification status")
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const result = await agentApi.cardWhoami(agentId);

        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          printTable([
            ["Email", result.email ?? c.dim("(not signed up)")],
            ["Verified", result.verified ? "Yes" : "No"],
          ]);
          printNextStep(result.nextStep);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // -- Profile --

  const profile = card
    .command("profile")
    .description("Manage the cardholder profile")
    .action(async (_opts, cmd) => {
      // Default: `acp card profile` → get profile.
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const result = await agentApi.cardGetProfile(agentId);
        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          printProfile(result);
          printNextStep(result.nextStep);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  profile
    .command("set")
    .description("Update cardholder profile fields")
    .option("--first-name <name>", "First name")
    .option("--last-name <name>", "Last name")
    .option(
      "--phone-number <phone>",
      "Phone number in E.164 format (e.g. +14155551234)"
    )
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      const patch: {
        firstName?: string;
        lastName?: string;
        phoneNumber?: string;
      } = {};
      if (opts.firstName) patch.firstName = String(opts.firstName).trim();
      if (opts.lastName) patch.lastName = String(opts.lastName).trim();
      if (opts.phoneNumber) patch.phoneNumber = String(opts.phoneNumber).trim();

      if (Object.keys(patch).length === 0) {
        outputError(
          json,
          "Provide at least one of --first-name, --last-name, --phone-number."
        );
        return;
      }

      // Mirror the BE E.164 validator so malformed numbers fail fast.
      if (
        patch.phoneNumber !== undefined &&
        !/^\+[1-9]\d{1,14}$/.test(patch.phoneNumber)
      ) {
        outputError(json, "phoneNumber must be E.164, e.g. +14155551234");
        return;
      }

      try {
        const result = await agentApi.cardUpdateProfile(agentId, patch);
        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          console.log(`${c.green("Profile updated.")}\n`);
          printProfile(result);
          printNextStep(result.nextStep);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  profile
    .command("reset")
    .description(
      "Wipe profile (name, phone, payment method). Token stays valid; spend limit and issued cards are unaffected."
    )
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const result = await agentApi.cardResetProfile(agentId);
        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          console.log(c.green("Profile reset."));
          printNextStep(result.nextStep);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // -- Payment method --

  card
    .command("payment-method")
    .description(
      "Start Stripe setup for a new payment method. Open the returned URL to complete setup."
    )
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const result = await agentApi.cardStartPaymentMethodSetup(agentId);
        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          console.log(`${c.green("Stripe setup session created.")}`);
          console.log(`\nComplete setup at: ${c.cyan(result.url)}`);
          printNextStep(result.nextStep);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // -- Spend limit --

  const limit = card
    .command("limit")
    .description("Get or set the spend limit")
    .action(async (_opts, cmd) => {
      // Default: `acp card limit` → get.
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const result = await agentApi.cardGetLimit(agentId);
        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          printTable([
            ["Spend Limit", formatCents(result.spendLimitCents)],
            ["Spent", formatCents(result.spentCents)],
            ["Remaining", formatCents(result.remainingCents)],
          ]);
          printNextStep(result.nextStep);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  limit
    .command("set")
    .description("Set the spend limit (amount in cents, min 100)")
    .option("--amount <cents>", "Spend limit in cents (min 100)")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      let rl: readline.Interface | undefined;
      try {
        let amountCents: number;
        if (opts.amount !== undefined) {
          amountCents = parseInt(opts.amount, 10);
        } else {
          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          amountCents = parseInt(
            (await prompt(rl, "Spend limit (cents, min 100): ")).trim(),
            10
          );
        }

        if (!Number.isInteger(amountCents) || amountCents < 100) {
          outputError(
            json,
            "Spend limit must be an integer of at least 100 cents."
          );
          return;
        }

        const result = await agentApi.cardSetLimit(agentId, amountCents);
        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          console.log(
            `${c.green("Spend limit set to")} ${c.bold(formatCents(result.spendLimitCents))}`
          );
          printTable([
            ["Spent", formatCents(result.spentCents)],
            ["Remaining", formatCents(result.remainingCents)],
          ]);
          printNextStep(result.nextStep);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      } finally {
        rl?.close();
      }
    });

  // -- Spend requests (issue + read cards) --

  card
    .command("issue")
    .description(
      "Issue a single-use virtual card ($1–$75, increments of $1). Returns PAN/CVV/expiry inline."
    )
    .option(
      "--amount <cents>",
      "Card amount in cents (100–7500, divisible by 100)"
    )
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      let rl: readline.Interface | undefined;
      try {
        let amountCents: number;
        if (opts.amount !== undefined) {
          amountCents = parseInt(opts.amount, 10);
        } else {
          rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          amountCents = parseInt(
            (
              await prompt(
                rl,
                "Card amount in cents (100–7500, multiples of 100): "
              )
            ).trim(),
            10
          );
        }

        // Mirror BE IssueCardDto: 100–7500, divisibleBy 100.
        if (
          !Number.isInteger(amountCents) ||
          amountCents < 100 ||
          amountCents > 7500 ||
          amountCents % 100 !== 0
        ) {
          outputError(
            json,
            "Amount must be 100–7500 cents, divisible by 100."
          );
          return;
        }

        const result = await agentApi.cardIssue(agentId, amountCents);
        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          console.log(
            `\n${c.green("Card issued!")} ${c.dim("(PAN/CVV shown once — store them now)")}`
          );
          const rows: [string, string][] = [
            ["Request ID", result.id],
            ["Amount", formatCents(result.amountCents)],
            ["PAN", result.pan],
            ["CVV", result.cvv],
            ["Expiry", `${result.expiryMonth}/${result.expiryYear}`],
          ];
          if (result.zip) rows.push(["ZIP", result.zip]);
          if (result.cardholderName)
            rows.push(["Cardholder", result.cardholderName]);
          rows.push(["Expires", formatDate(result.expiresAt)]);
          printTable(rows);
          printNextStep(result.nextStep);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      } finally {
        rl?.close();
      }
    });

  card
    .command("list")
    .description("List spend-requests issued by this agent")
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const result = await agentApi.cardListRequests(agentId);

        if (json) {
          process.stdout.write(JSON.stringify(result) + "\n");
          return;
        }

        if (result.requests.length === 0) {
          console.log("No cards issued yet.");
          return;
        }

        for (const r of result.requests) {
          printSpendRequest(r);
          console.log();
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // `get` uses --request-id (flag) to match the rest of the CLI —
  // see `job watch --job-id`, `offering update --offering-id`, etc.
  card
    .command("get")
    .description("Get a single spend-request by ID")
    .requiredOption("--request-id <id>", "Spend-request ID")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const result = await agentApi.cardGetRequest(agentId, opts.requestId);
        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          printSpendRequest(result);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
