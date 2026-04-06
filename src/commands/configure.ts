import { exec } from "child_process";
import type { Command } from "commander";
import { isJson, outputResult, outputError } from "../lib/output";
import { CliError } from "../lib/errors";
import { AuthApi } from "../lib/api/auth";
import { ApiClient } from "../lib/api/client";
import { setTokens } from "../lib/config";
import { ACP_SERVER_URL } from "acp-node-v2";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd);
}

async function waitForToken(
  authApi: AuthApi,
  requestId: string
): Promise<{ token: string; refreshToken: string } | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const result = await authApi.pollCliToken(requestId);
    if (result) return result;
  }
  return null;
}

export function registerConfigureCommand(program: Command): void {
  program
    .command("configure")
    .description("Authenticate the CLI with ACP")
    .action(async (_opts, cmd) => {
      const json = isJson(cmd);
      const apiUrl = process.env.ACP_API_URL || ACP_SERVER_URL;
      const authApi = new AuthApi(new ApiClient(apiUrl));

      let url: string;
      let requestId: string;
      try {
        ({ url, requestId } = await authApi.getCliUrl());
      } catch (err) {
        outputError(
          json,
          `Failed to get auth URL: ${
            err instanceof Error ? err : String(err)
          }`
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

      await setTokens(result.token, result.refreshToken);

      if (json) {
        outputResult(json, {
          message: "Successfully authenticated to ACP CLI",
        });
      } else {
        console.log("Successfully authenticated to ACP CLI");
      }
    });
}
