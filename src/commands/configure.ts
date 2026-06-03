import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output";
import { CliError } from "../lib/errors";
import { AuthApi } from "../lib/api/auth";
import { getClient } from "../lib/api/client";
import { setCurrentOwnerWallet, setTokens } from "../lib/config";
import { openBrowser } from "../lib/browser";

// In --json mode the URL goes to stdout as JSON for machine parsing, but many
// agent harnesses buffer or suppress stdout while passing stderr through to the
// human. Mirroring a plain, copy-pasteable line to stderr guarantees the
// sign-in link reaches the human even if the agent never relays the JSON.
function emitAuthUrlToStderr(url: string): void {
  process.stderr.write(`\n>>> Open this URL to sign in:\n\n    ${url}\n\n`);
}

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

async function waitForToken(
  authApi: AuthApi,
  requestId: string,
  timeoutMs: number = POLL_TIMEOUT_MS
): Promise<{
  token: string;
  refreshToken: string;
  walletAddress: string;
} | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const result = await authApi.pollCliToken(requestId);
    if (result) return result;
  }
  return null;
}

async function persistTokens(result: {
  token: string;
  refreshToken: string;
  walletAddress: string;
}): Promise<void> {
  setCurrentOwnerWallet(result.walletAddress);
  await setTokens(result.token, result.refreshToken, result.walletAddress);
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
    // Also surface the URL on stderr as a plain human line. Many agent
    // harnesses buffer or hide stdout but pass stderr through to the human,
    // so this guarantees the sign-in link is visible even if the agent
    // never relays the JSON itself. Does not affect the stdout JSON contract.
    emitAuthUrlToStderr(url);
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

  await persistTokens(result);

  if (json) {
    outputResult(json, {
      message: "Successfully authenticated to ACP CLI",
      walletAddress: result.walletAddress,
    });
  } else {
    console.log("Successfully authenticated to ACP CLI");
  }
}

// --- Agent-friendly split flow ---------------------------------------------
// `configure start` returns {url, requestId} and exits 0 immediately, so a
// non-interactive agent can capture and relay the URL without backgrounding
// the process. `configure complete` then exchanges the requestId for tokens on
// the agent's own cadence.

async function runConfigureStart(json: boolean): Promise<void> {
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

  openBrowser(url);

  if (json) {
    outputResult(json, { url, requestId });
    // See note in runBrowserConfigure: mirror the URL to stderr so harnesses
    // that swallow stdout still show the human a clickable sign-in link.
    emitAuthUrlToStderr(url);
  } else {
    console.log(`\nOpen this URL to authenticate:\n\n  ${url}\n`);
    console.log(
      `Then run:\n\n  acp configure complete --request-id ${requestId}\n`
    );
  }
}

async function runConfigureComplete(
  requestId: string,
  json: boolean,
  opts: { wait?: boolean; timeout?: string }
): Promise<void> {
  if (!requestId) {
    outputError(
      json,
      new CliError(
        "Missing --request-id.",
        "VALIDATION_ERROR",
        "Pass the requestId returned by `acp configure start`."
      )
    );
    return;
  }

  const { authApi } = await getClient(true);

  // Default: single non-blocking poll. With --wait, block until timeout.
  if (opts.wait) {
    const timeoutMs = opts.timeout
      ? Math.max(0, Number(opts.timeout) * 1000)
      : POLL_TIMEOUT_MS;
    const result = await waitForToken(authApi, requestId, timeoutMs);
    if (!result) {
      outputError(
        json,
        new CliError(
          "Authentication timed out.",
          "TIMEOUT",
          "Re-run `acp configure start` to get a fresh URL."
        )
      );
      return;
    }
    await persistTokens(result);
    outputResult(json, {
      message: "Successfully authenticated to ACP CLI",
      walletAddress: result.walletAddress,
    });
    return;
  }

  const result = await authApi.pollCliToken(requestId);
  if (!result) {
    // Not an error — login just isn't complete yet. Agent polls again.
    outputResult(json, { status: "pending" });
    return;
  }
  await persistTokens(result);
  outputResult(json, {
    status: "authenticated",
    message: "Successfully authenticated to ACP CLI",
    walletAddress: result.walletAddress,
  });
}

export function registerConfigureCommand(program: Command): void {
  const configure = program
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

  configure
    .command("start")
    .description(
      "Get the auth URL and requestId, then exit immediately (agent-friendly; relay the URL, then `configure complete`)"
    )
    .action(async (_opts, cmd) => {
      await runConfigureStart(isJson(cmd));
    });

  configure
    .command("complete")
    .description(
      "Exchange a requestId for tokens and persist them. Returns {status:'pending'} until the human finishes sign-in."
    )
    .requiredOption(
      "--request-id <requestId>",
      "The requestId returned by `acp configure start`"
    )
    .option(
      "--wait",
      "Block and keep polling until authenticated or timeout (instead of a single check)"
    )
    .option(
      "--timeout <seconds>",
      "With --wait, maximum seconds to wait (default 300)"
    )
    .action(async (opts, cmd) => {
      await runConfigureComplete(opts.requestId, isJson(cmd), {
        wait: opts.wait,
        timeout: opts.timeout,
      });
    });
}
