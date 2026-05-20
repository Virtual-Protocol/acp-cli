import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output";
import { CliError } from "../lib/errors";
import { AuthApi } from "../lib/api/auth";
import { getClient } from "../lib/api/client";
import { setCurrentOwnerWallet, setTokens } from "../lib/config";
import { openBrowser } from "../lib/browser";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

async function waitForToken(
  authApi: AuthApi,
  requestId: string
): Promise<{
  token: string;
  refreshToken: string;
  walletAddress: string;
} | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const result = await authApi.pollCliToken(requestId);
    if (result) return result;
  }
  return null;
}

interface HeadlessInputs {
  token?: string;
  refreshToken?: string;
  wallet?: string;
}

function readHeadlessInputs(opts: {
  token?: string;
  refreshToken?: string;
  wallet?: string;
}): HeadlessInputs {
  return {
    token: opts.token ?? process.env.ACP_ACCESS_TOKEN,
    refreshToken: opts.refreshToken ?? process.env.ACP_REFRESH_TOKEN,
    wallet: opts.wallet ?? process.env.ACP_OWNER_WALLET,
  };
}

async function runHeadlessConfigure(
  inputs: HeadlessInputs,
  json: boolean
): Promise<void> {
  const missing: string[] = [];
  if (!inputs.token) missing.push("--token / ACP_ACCESS_TOKEN");
  if (!inputs.refreshToken) missing.push("--refresh-token / ACP_REFRESH_TOKEN");
  if (!inputs.wallet) missing.push("--wallet / ACP_OWNER_WALLET");
  if (missing.length > 0) {
    outputError(
      json,
      new CliError(
        `Headless configure is missing required inputs: ${missing.join(", ")}.`,
        "VALIDATION_ERROR",
        "Provide all three values via flags or env vars, or omit them all to use the browser flow."
      )
    );
    return;
  }

  setCurrentOwnerWallet(inputs.wallet!);
  await setTokens(inputs.token!, inputs.refreshToken!, inputs.wallet!);

  outputResult(json, {
    message: "Successfully authenticated to ACP CLI",
    walletAddress: inputs.wallet,
  });
}

async function runBrowserConfigure(json: boolean): Promise<void> {
  const { authApi } = await getClient(true);

  let url: string;
  let requestId: string;
  try {
    ({ url, requestId } = await authApi.getCliUrl());
  } catch (err) {
    outputError(
      json,
      `Failed to get auth URL: ${err instanceof Error ? err : String(err)}`
    );
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ url }) + "\n");
  } else {
    console.log(`\nOpen this URL to authenticate:\n\n  ${url}\n`);
  }
  openBrowser(url);

  if (!json) {
    console.log("Waiting for authentication...");
  }

  const result = await waitForToken(authApi, requestId);
  if (!result) {
    outputError(
      json,
      new CliError(
        "Authentication timed out.",
        "TIMEOUT",
        "Run `acp configure` again and complete the browser authentication."
      )
    );
    return;
  }

  setCurrentOwnerWallet(result.walletAddress);
  await setTokens(result.token, result.refreshToken, result.walletAddress);

  if (json) {
    outputResult(json, {
      message: "Successfully authenticated to ACP CLI",
      walletAddress: result.walletAddress,
    });
  } else {
    console.log("Successfully authenticated to ACP CLI");
  }
}

export function registerConfigureCommand(program: Command): void {
  program
    .command("configure")
    .description("Authenticate the CLI with ACP")
    .option(
      "--token <accessToken>",
      "Access token (skips browser; also reads ACP_ACCESS_TOKEN)"
    )
    .option(
      "--refresh-token <refreshToken>",
      "Refresh token (required with --token; also reads ACP_REFRESH_TOKEN)"
    )
    .option(
      "--wallet <ownerWallet>",
      "Owner wallet address (required with --token; also reads ACP_OWNER_WALLET)"
    )
    .action(async (opts, cmd) => {
      const json = isJson(cmd);
      const inputs = readHeadlessInputs(opts);
      const anyProvided =
        inputs.token != null ||
        inputs.refreshToken != null ||
        inputs.wallet != null;

      if (anyProvided) {
        await runHeadlessConfigure(inputs, json);
        return;
      }

      await runBrowserConfigure(json);
    });
}
