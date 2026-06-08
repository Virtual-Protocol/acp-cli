// Read-only Hyperliquid info client, used by `acp trade status`.
//
// All HL TRADING (perp / spot / withdraw) now runs through the backend
// `/trade/plan` + `/trade/next` loop: the server reads HL state, builds each
// EIP-712 action, and the CLI signs it with the agent wallet. So the CLI no
// longer wires an ExchangeClient or a signer here — only the public InfoClient
// for the read-only account view.

import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";

export function isTestnet(): boolean {
  return process.env.IS_TESTNET === "true";
}

export function createHlInfoClient(): InfoClient {
  return new InfoClient({
    transport: new HttpTransport({ isTestnet: isTestnet() }),
  });
}
