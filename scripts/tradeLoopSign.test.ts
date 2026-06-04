// Standalone harness (run via `npx tsx`) exercising runTradeLoop's `sign`
// branch — the new path that lets the trading-agent planner drive the
// Treasures flow. The CLI has no jest runner, so this is a tsx assertion
// script: it stubs the provider + global.fetch and verifies the loop signs
// what it's asked and posts the signature back.

import assert from "node:assert";
import { runTradeLoop } from "../src/commands/trade";

interface SignCall {
  kind: "typed" | "message";
  chainId: number;
  payload: unknown;
}
interface PostBody {
  path: string;
  body: any;
}

function fakeProvider(calls: SignCall[]) {
  return {
    async signTypedData(chainId: number, typedData: unknown) {
      calls.push({ kind: "typed", chainId, payload: typedData });
      return "0xTYPEDSIG";
    },
    async signMessage(chainId: number, message: string) {
      calls.push({ kind: "message", chainId, payload: message });
      return "0xMSGSIG";
    },
    async sendTransaction() {
      throw new Error("sendTransaction should not be called in this test");
    },
  } as any;
}

// Stub global.fetch; `nextActions` is consumed one /trade/next call at a time.
function installFetch(nextActions: any[], posts: PostBody[]) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    const u = new URL(url);
    posts.push({ path: u.pathname, body: JSON.parse(init.body) });
    const action = nextActions.shift();
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ tradeId: "t", step: posts.length, action }),
    } as Response;
  }) as typeof fetch;
  return () => (globalThis.fetch = orig);
}

async function testEip712LegSign() {
  const calls: SignCall[] = [];
  const posts: PostBody[] = [];
  const restore = installFetch(
    [{ kind: "done", status: "success", result: { ok: true } }],
    posts
  );
  try {
    const plan = {
      tradeId: "t",
      step: 0,
      direction: "buy",
      route: "treasures-only",
      action: {
        kind: "sign",
        sigType: "eip712",
        chainId: 1,
        typedData: { domain: { chainId: 1 }, primaryType: "Order" },
        expectedSignKind: "treasures-leg",
        label: "Sign Treasures leg",
      },
    } as any;
    const result = await runTradeLoop(
      "https://fake.test",
      "tok",
      fakeProvider(calls),
      plan,
      true
    );
    assert.deepStrictEqual(result, { ok: true }, "returns the done result");
    assert.strictEqual(calls.length, 1, "signed once");
    assert.strictEqual(calls[0].kind, "typed", "used signTypedData for eip712");
    assert.strictEqual(calls[0].chainId, 1, "signed on the action's chainId");
    assert.strictEqual(posts.length, 1, "posted /trade/next once");
    assert.strictEqual(posts[0].path, "/trade/next");
    assert.strictEqual(
      posts[0].body.signature,
      "0xTYPEDSIG",
      "posted the signature back"
    );
    assert.ok(
      posts[0].body.txHash === undefined,
      "no txHash on a sign step"
    );
  } finally {
    restore();
  }
  console.log("✓ eip712 leg sign → posts signature, returns done");
}

async function testPersonalProofSign() {
  const calls: SignCall[] = [];
  const posts: PostBody[] = [];
  // proof sign → next action is another sign (eip712) → next is done.
  const restore = installFetch(
    [
      {
        kind: "sign",
        sigType: "eip712",
        chainId: 1,
        typedData: { primaryType: "Order" },
        label: "leg",
      },
      { kind: "done", status: "success", result: { filled: "0.5 AAPL" } },
    ],
    posts
  );
  try {
    const plan = {
      tradeId: "t",
      step: 0,
      action: {
        kind: "sign",
        sigType: "personal",
        chainId: 8453,
        message: "treasures-finance-quote-v1\n1700000000\n\n0xabc",
        expectedSignKind: "treasures-proof",
        label: "Sign ownership proof",
      },
    } as any;
    const result = await runTradeLoop(
      "https://fake.test",
      "tok",
      fakeProvider(calls),
      plan,
      true
    );
    assert.deepStrictEqual(result, { filled: "0.5 AAPL" });
    assert.strictEqual(calls.length, 2, "two signatures (proof + leg)");
    assert.strictEqual(calls[0].kind, "message", "proof uses personal_sign");
    assert.strictEqual(calls[0].chainId, 8453, "proof signed on Base");
    assert.strictEqual(calls[1].kind, "typed", "leg uses signTypedData");
    assert.strictEqual(posts[0].body.signature, "0xMSGSIG");
    assert.strictEqual(posts[1].body.signature, "0xTYPEDSIG");
  } finally {
    restore();
  }
  console.log("✓ personal proof sign → then eip712 leg → done");
}

async function testSignFailureReportsError() {
  const posts: PostBody[] = [];
  // After the failed sign is reported, the server returns a terminal error.
  const restore = installFetch(
    [
      {
        kind: "error",
        code: "SIGN_FAILED",
        message: "user rejected",
        retryable: false,
      },
    ],
    posts
  );
  const provider = {
    async signTypedData() {
      throw new Error("user rejected");
    },
    async signMessage() {
      throw new Error("user rejected");
    },
    async sendTransaction() {
      throw new Error("nope");
    },
  } as any;
  try {
    const plan = {
      tradeId: "t",
      step: 0,
      action: {
        kind: "sign",
        sigType: "eip712",
        chainId: 1,
        typedData: {},
        label: "leg",
      },
    } as any;
    let threw = false;
    try {
      await runTradeLoop("https://fake.test", "tok", provider, plan, true);
    } catch (e) {
      threw = true;
    }
    assert.ok(threw, "a terminal error action throws out of the loop");
    assert.strictEqual(
      posts[0].body.error.code,
      "SIGN_FAILED",
      "reported the sign failure to the server"
    );
  } finally {
    restore();
  }
  console.log("✓ sign failure → reported to server, loop errors out");
}

async function main() {
  await testEip712LegSign();
  await testPersonalProofSign();
  await testSignFailureReportsError();
  console.log("\nAll runTradeLoop sign-branch tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
