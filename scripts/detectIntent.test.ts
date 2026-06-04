// tsx harness for detectIntent — focuses on the new Treasures routing:
// direct buy/sell, the funded-buy path, and that it doesn't poach swaps.

import assert from "node:assert";
import { detectIntent } from "../src/commands/trade";

const cases: Array<[string, Record<string, unknown>, string]> = [
  // Direct Treasures buy / sell (unchanged behavior).
  ["direct buy", { token: "AAPL", amountUsdc: "50" }, "treasures-stock"],
  ["sell", { token: "AAPL", amountShares: "0.1" }, "treasures-stock"],

  // NEW: funded buy — ticker + funding flags, no --token-out/--chain-out.
  [
    "funded buy (eth on base)",
    { token: "AAPL", tokenIn: "eth", chainIn: "8453", amountIn: "0.02" },
    "treasures-stock",
  ],

  // A real swap still routes to swap (it has --token-out/--chain-out and no --token).
  [
    "swap stays a swap",
    {
      tokenIn: "usdc",
      chainIn: "8453",
      amountIn: "50",
      tokenOut: "virtual",
      chainOut: "8453",
    },
    "swap",
  ],

  // Perp routing is untouched.
  ["perp", { token: "BTC", side: "long", size: "0.01" }, "perp"],

  // HL spot / deposit / withdraw still route by chain.
  [
    "hl spot",
    { tokenIn: "usdc", chainIn: "1337", amountIn: "100", tokenOut: "PURR", chainOut: "1337" },
    "spot",
  ],
  [
    "deposit",
    { tokenIn: "usdc", chainIn: "8453", amountIn: "25", tokenOut: "usdc", chainOut: "1337" },
    "deposit",
  ],
];

for (const [name, opts, expected] of cases) {
  const got = detectIntent(opts, true);
  assert.strictEqual(got, expected, `${name}: expected ${expected}, got ${got}`);
  console.log(`✓ ${name} → ${got}`);
}

// A bare --token with no companion flag is an incomplete perp (surfaces a
// clear --side error downstream), NOT a treasures trade.
assert.strictEqual(detectIntent({ token: "BTC" }, true), "perp", "bare token → perp");
console.log("✓ bare --token → perp");

console.log("\nAll detectIntent routing tests passed.");
