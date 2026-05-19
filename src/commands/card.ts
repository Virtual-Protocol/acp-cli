import * as readline from "readline";
import type { Command } from "commander";
import { isJson, outputResult, outputError, formatDate } from "../lib/output";
import { c } from "../lib/color";
import { getClient, ApiError } from "../lib/api/client";
import { prompt, printTable } from "../lib/prompt";
import { getActiveAgentId } from "../lib/activeAgent";
import { getWalletAddress } from "../lib/agentFactory";
import { withApprovalGate } from "../lib/walletGate";
import { awaitApproval } from "@virtuals-protocol/acp-node-v2";
import type {
  CardProfileResponse,
  IssuedCardResponse,
  NextStep,
  SpendRequest,
  ThreeDSCode,
} from "../lib/api/agent";

const MAX_CARD_CENTS = 7500;

const CARD_THRESHOLD_TYPED_DATA = {
  primaryType: "SetCardApprovalThreshold" as const,
  types: {
    SetCardApprovalThreshold: [
      { name: "agentId", type: "string" },
      { name: "wallet", type: "address" },
      { name: "approvalRequired", type: "bool" },
      { name: "approvalThresholdCents", type: "uint256" },
      { name: "issuedAt", type: "uint256" },
    ],
  },
  domain: {
    name: "ACP",
    version: "1",
  },
};

// ── Formatters ──────────────────────────────────────────────────────

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Relative age for 3DS codes — the upstream window is ~5 minutes so a
// minute-precision label is the right grain.
function formatAge(receivedAt: string): string {
  const ts = new Date(receivedAt).getTime();
  if (!Number.isFinite(ts)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
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

// ── Approval handling ───────────────────────────────────────────────

interface ApprovalRequired {
  approvalId: string;
  approvalUrl: string;
  detail?: string;
}

function parseApprovalRequired(err: unknown): ApprovalRequired | null {
  if (!(err instanceof ApiError) || err.status !== 403) return null;
  const body = err.body;
  if (typeof body !== "object" || body === null) return null;
  const { code, detail, details } = body as Record<string, unknown>;
  if (code !== "APPROVAL_REQUIRED") return null;
  if (typeof details !== "object" || details === null) return null;
  const { approvalId, approvalUrl } = details as Record<string, unknown>;
  if (typeof approvalId !== "string" || typeof approvalUrl !== "string") {
    return null;
  }
  return {
    approvalId,
    approvalUrl,
    detail: typeof detail === "string" ? detail : undefined,
  };
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
            `\nPoll with: ${c.cyan(
              `acp card signup-poll --state ${result.state}`
            )}`
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
            [
              "Approval Threshold",
              result.approvalThresholdCents
                ? formatCents(result.approvalThresholdCents)
                : c.dim("(not set)"),
            ],
          ]);
          printNextStep(result.nextStep);
        }
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });

  // -- Approval threshold --

  card
    .command("approval-threshold")
    .description(
      "Set the spend approval threshold (cents, multiples of 100; $0 = requires approval for all). Signed with the active agent wallet."
    )
    .option(
      "--amount <cents>",
      "Approval threshold in cents (multiples of 100)"
    )
    .option("--disable", "Disable approval — no spend will require approval")
    .option("--chain-id <id>", "Chain ID to sign with", "8453")
    .action(async (opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        if (opts.disable && opts.amount !== undefined) {
          outputError(json, "Pass either --amount or --disable, not both.");
          return;
        }
        if (!opts.disable && opts.amount === undefined) {
          outputError(json, "Provide --amount <cents> or --disable.");
          return;
        }

        let amountCents: number;
        if (opts.disable) {
          amountCents = MAX_CARD_CENTS;
        } else {
          amountCents = parseInt(opts.amount, 10);
          if (
            !Number.isInteger(amountCents) ||
            amountCents < 0 ||
            amountCents % 100 !== 0
          ) {
            outputError(
              json,
              "Approval threshold must be a non-negative integer divisible by 100 cents."
            );
            return;
          }
        }

        const chainId = Number(opts.chainId);
        const walletAddress = getWalletAddress();
        const issuedAt = Math.floor(Date.now() / 1000);

        const typedData = {
          ...CARD_THRESHOLD_TYPED_DATA,
          domain: {
            ...CARD_THRESHOLD_TYPED_DATA.domain,
            chainId,
          },
          message: {
            agentId,
            wallet: walletAddress,
            approvalRequired: !opts.disable,
            approvalThresholdCents: opts.disable ? 0 : amountCents,
            issuedAt,
          },
        };

        const signature = await withApprovalGate(async (provider) => {
          const supportedChainIds = await provider.getSupportedChainIds();
          if (!supportedChainIds.includes(chainId)) {
            throw new Error(
              `Unsupported chain ID: ${
                opts.chainId
              }. Supported: ${supportedChainIds.join(", ")}`
            );
          }
          return provider.signTypedData(chainId, typedData);
        });

        const result = await agentApi.cardSetApprovalThreshold(agentId, {
          approvalThresholdCents: amountCents,
          signature,
          issuedAt,
          chainId,
        });

        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else if (opts.disable) {
          console.log(
            c.green("Approval disabled — no spend will require approval.")
          );
          printNextStep(result.nextStep);
        } else {
          const cents = result.approvalThresholdCents ?? amountCents;
          console.log(
            `${c.green("Approval threshold set to")} ${c.bold(
              formatCents(cents)
            )}${cents === 0 ? c.dim(" (all spends require approval)") : ""}`
          );
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
            `${c.green("Spend limit set to")} ${c.bold(
              formatCents(result.spendLimitCents)
            )}`
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
          outputError(json, "Amount must be 100–7500 cents, divisible by 100.");
          return;
        }
        const result = await withApprovalGate(async () => {
          try {
            return await agentApi.cardIssue(agentId, amountCents);
          } catch (err) {
            const approval = parseApprovalRequired(err);
            if (!approval) throw err;

            if (json) {
              process.stderr.write(
                `Owner approval required — approve at: ${approval.approvalUrl}\n`
              );
            } else {
              console.log(`\n${c.yellow("Owner approval required.")}`);
              if (approval.detail) console.log(`  ${c.dim(approval.detail)}`);
              console.log(`  Approve at: ${c.cyan(approval.approvalUrl)}`);
              console.log(c.dim("  Waiting for owner approval…"));
            }

            return awaitApproval<IssuedCardResponse>(approval.approvalId);
          }
        });

        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
        } else {
          console.log(
            `\n${c.green("Card issued!")} ${c.dim(
              "(PAN/CVV shown once — store them now)"
            )}`
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

  // -- 3DS verification codes --
  //
  // When a merchant runs a 3DS challenge against an issued card, the
  // verification code lands at agentcard.ai; agents poll this command to
  // read it back to checkout. Window is ~5 minutes.

  card
    .command("3ds")
    .description(
      "List recent 3DS verification codes (for merchant challenges; ~5 min window)"
    )
    .action(async (_opts, cmd) => {
      const { agentApi } = await getClient();
      const json = isJson(cmd);
      const agentId = getActiveAgentId(json);
      if (!agentId) return;

      try {
        const result = await agentApi.cardList3DSCodes(agentId);

        if (json) {
          outputResult(json, result as unknown as Record<string, unknown>);
          return;
        }

        if (result.codes.length === 0) {
          console.log("No recent 3DS codes.");
          console.log(
            c.dim(
              "  Make sure checkout requested a 3DS challenge. Codes usually appear here within a few seconds."
            )
          );
          return;
        }

        // Compact per-row layout. printTable is 2-col only and we want
        // code / amount / age side-by-side without the label gutter.
        const codeWidth = Math.max(
          ...result.codes.map((code: ThreeDSCode) => code.code.length)
        );
        for (const item of result.codes) {
          const amount = `USD ${item.amount.toFixed(2)}`;
          console.log(
            `  ${c.bold(item.code.padEnd(codeWidth))}   ${c.green(
              amount.padEnd(10)
            )} ${c.dim(formatAge(item.receivedAt))}`
          );
        }
        console.log(
          c.dim(
            "\nNo match? Re-run `acp card 3ds` after checkout sends the challenge."
          )
        );
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}
