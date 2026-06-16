import type { Command } from "commander";
import { isAddress } from "viem";
import { isJson, outputResult, outputError } from "../lib/output";
import { CliError } from "../lib/errors";
import { c } from "../lib/color";
import { printTable } from "../lib/prompt";
import { getClient } from "../lib/api/client";
import type { ContractEntry, PolicyChainType } from "../lib/api/policy";
import { dashboardWalletPoliciesUrl } from "../lib/dashboard";
import { openBrowser } from "../lib/browser";

const CHAIN_TYPES: PolicyChainType[] = ["ETHEREUM", "SOLANA", "TRON", "SUI"];

// Parse a `--contract` entry. Accepts a bare address (`0xabc…`) or a labeled
// form (`My Router=0xabc…`); the part before the first `=` becomes the label.
function parseContractEntry(raw: string): ContractEntry {
  const eq = raw.indexOf("=");
  if (eq === -1) return { address: raw.trim() };
  return {
    name: raw.slice(0, eq).trim() || null,
    address: raw.slice(eq + 1).trim(),
  };
}

// Why deep-link instead of doing it here: editing/deleting a policy mutates a
// resource owned by the user's Privy account and requires their session
// signature, which the CLI's signer key cannot produce. Only the dashboard can.
// We pass policyId + action so the dashboard opens that policy's dialog directly.
function deferToDashboard(
  json: boolean,
  label: string,
  open: boolean,
  policyId: string,
  action: "edit" | "delete"
): void {
  const url = dashboardWalletPoliciesUrl({ policyId, action });
  if (json) {
    outputResult(json, {
      reason: `${label} requires wallet-owner approval — open the url in a browser to continue.`,
      url,
    });
    return;
  }
  console.log(
    `\n${c.yellow(`${label} requires wallet-owner approval.`)}\n` +
      `This signs with your wallet owner's session, which only the dashboard can do.\n\n` +
      `Open Wallet Policies here:\n\n    ${url}\n`
  );
  if (open) openBrowser(url);
}

export function registerPolicyCommands(program: Command): void {
  const policy = program
    .command("policy")
    .description("Manage reusable wallet policies (guardrails for agent signers)");

  policy
    .command("create")
    .description(
      "Create a custom wallet policy: an allowlist of contract/wallet addresses a signer may interact with. ETHEREUM only."
    )
    .requiredOption("--name <name>", "Policy name (max 50 chars)")
    .requiredOption(
      "--contract <entry...>",
      "Allowlisted address(es). Repeatable. Use `0xaddr` or `Label=0xaddr` to attach a name."
    )
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      const name = String(opts.name).trim();
      if (!name || name.length > 50) {
        outputError(
          json,
          new CliError(
            "Invalid policy name.",
            "VALIDATION_ERROR",
            "Provide a non-empty --name of at most 50 characters."
          )
        );
        return;
      }

      const rawContracts: string[] = Array.isArray(opts.contract)
        ? opts.contract
        : [opts.contract];
      const contracts = rawContracts.map(parseContractEntry);

      const bad = contracts.find((entry) => !isAddress(entry.address));
      if (bad) {
        outputError(
          json,
          new CliError(
            `Invalid contract address: "${bad.address}".`,
            "VALIDATION_ERROR",
            "Each --contract must be a valid EVM address (0x…), optionally as `Label=0xaddr`."
          )
        );
        return;
      }

      const { policyApi } = await getClient();
      try {
        const res = await policyApi.createPolicy({ name, contracts });
        const created = res.data.policy;
        if (json) {
          outputResult(json, created as unknown as Record<string, unknown>);
          return;
        }
        console.log(`\n${c.green(`Policy "${created.name}" created.`)}\n`);
        printTable([
          ["ID", created.id],
          ["Privy Policy ID", created.policyId],
          ["Chain", created.chainType],
          ["Contracts", created.contracts.join("\n           ")],
        ]);
      } catch (err) {
        outputError(
          json,
          `Failed to create policy: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    });

  policy
    .command("list")
    .description("List your custom wallet policies")
    .option("--limit <number>", "Page size (1-100, default 20)")
    .option("--cursor <cursor>", "Pagination cursor from a previous page")
    .option(
      "--chain-type <type>",
      `Filter by chain type: ${CHAIN_TYPES.join(", ")}`
    )
    .action(async (opts, cmd) => {
      const json = isJson(cmd);

      let chainType: PolicyChainType | undefined;
      if (opts.chainType) {
        const upper = String(opts.chainType).toUpperCase() as PolicyChainType;
        if (!CHAIN_TYPES.includes(upper)) {
          outputError(
            json,
            new CliError(
              `Invalid chain type "${opts.chainType}".`,
              "VALIDATION_ERROR",
              `Use one of: ${CHAIN_TYPES.join(", ")}.`
            )
          );
          return;
        }
        chainType = upper;
      }

      const { policyApi } = await getClient();
      try {
        const res = await policyApi.listPolicies({
          limit: opts.limit ? Number(opts.limit) : undefined,
          cursor: opts.cursor,
          chainType,
        });
        if (json) {
          outputResult(json, res as unknown as Record<string, unknown>);
          return;
        }
        const policies = res.data ?? [];
        if (policies.length === 0) {
          console.log("\nNo custom policies yet.\n");
          return;
        }
        console.log("");
        for (const p of policies) {
          console.log(
            `${c.bold(p.name)}  ${c.dim(p.id)}\n  ${p.contracts.length} address(es): ${p.contracts.join(", ")}`
          );
        }
        const next = res.meta?.pagination?.nextCursor;
        if (next) console.log(`\n${c.dim(`Next page: --cursor ${next}`)}`);
      } catch (err) {
        outputError(
          json,
          `Failed to list policies: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    });

  policy
    .command("show <id>")
    .description("Show a single policy's details (local + Privy definition)")
    .action(async (id, _opts, cmd) => {
      const json = isJson(cmd);
      const { policyApi } = await getClient();
      try {
        const res = await policyApi.getPolicy(String(id));
        if (json) {
          outputResult(json, res.data as unknown as Record<string, unknown>);
          return;
        }
        const p = res.data.policy;
        printTable([
          ["Name", p.name],
          ["ID", p.id],
          ["Privy Policy ID", p.policyId],
          ["Chain", p.chainType],
          ["Contracts", p.contracts.join("\n           ")],
        ]);
      } catch (err) {
        outputError(
          json,
          `Failed to fetch policy: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    });

  policy
    .command("global")
    .description("List platform-managed policy presets (e.g. DENY_ALL, ACP_ONLY)")
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);
      const { policyApi } = await getClient();
      try {
        const res = await policyApi.getGlobalPolicies();
        if (json) {
          outputResult(json, { data: res.data });
          return;
        }
        console.log("");
        printTable(res.data.map((g) => [g.name, g.policyId]));
      } catch (err) {
        outputError(
          json,
          `Failed to fetch global policies: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    });

  policy
    .command("edit <id>")
    .description("Edit a policy (opens the dashboard — requires wallet-owner approval)")
    .option("--open", "Also open the dashboard in a browser")
    .action((id, opts, cmd) => {
      deferToDashboard(
        isJson(cmd),
        "Editing a policy",
        opts.open === true,
        String(id),
        "edit"
      );
    });

  policy
    .command("delete <id>")
    .description("Delete a policy (opens the dashboard — requires wallet-owner approval)")
    .option("--open", "Also open the dashboard in a browser")
    .action((id, opts, cmd) => {
      deferToDashboard(
        isJson(cmd),
        "Deleting a policy",
        opts.open === true,
        String(id),
        "delete"
      );
    });
}
