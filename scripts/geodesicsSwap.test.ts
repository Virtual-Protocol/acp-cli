// Standalone harness (run via `npx tsx`) exercising `acp swap`'s executeSwap +
// signer bridges. The CLI has no jest runner, so this is a tsx assertion
// script (same pattern as tradeLoopSign.test.ts): it stubs the Geodesics
// client's fetch and fake providers, and verifies the EVM bridge signs the
// operation hash as raw bytes, collects a delegation authorization for a
// first swap from a new chain, and rejects a signer that authorizes the wrong
// target; the Solana bridge signs the whole prebuilt transaction; the SOL fee
// pipe funds and retries a refused same-chain swap (and refuses without
// --confirm-pipe); quotes surface price-impact data and gate high impact
// behind --accept-impact; canonical token symbols resolve chain-scoped; and a
// settlement-wait timeout maps to a typed TIMEOUT carrying the swap id.

import assert from "node:assert";
import { getAddress } from "viem";
import {
  CHAIN_IDS,
  createGeodesicsClient,
  GeodesicsTimeoutError,
  type QuoteRequest,
  type QuoteResponse,
} from "@geodesics-protocol/sdk";
import type {
  IEvmProviderAdapter,
  ISolanaProviderAdapter,
} from "@virtuals-protocol/acp-node-v2";
import {
  assertImpactAccepted,
  assertSufficientSolanaBalance,
  createGeodesicsSolanaSwapSigner,
  createGeodesicsSwapSigner,
  executeSwap,
  preflightSolanaQuote,
  resolveInputToken,
  resolveOutputToken,
  resolveSolanaInputToken,
  runGeodesics,
} from "../src/commands/swap";
import { CliError } from "../src/lib/errors";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DELEGATION_TARGET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const GEO_OP_HASH = `0x${"ab".repeat(32)}`;
const SIGNATURE = `0x${"11".repeat(65)}`;
const SOLANA_WALLET = "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj";
const UNSIGNED_SOLANA_TX = "dW5zaWduZWQtc29sYW5hLXR4";
const SIGNED_SOLANA_TX = "c2lnbmVkLXNvbGFuYS10eA==";

interface RecordedCall {
  kind: "message" | "send" | "authorization" | "solana-tx";
  chainId: number;
  payload: unknown;
}
interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

type FakeAuthorizationSigner = {
  signAuthorization(request: {
    contractAddress: string;
    chainId: number;
    nonce: number;
  }): Promise<{
    address: string;
    nonce: number;
    chainId: number;
    yParity: number | string;
    r: string;
    s: string;
  }>;
};

function fakeProvider(
  calls: RecordedCall[],
  opts: {
    withAuthorizationSigner?: boolean;
    echoAddress?: string;
    readContractBalance?: bigint;
  } = {}
): IEvmProviderAdapter {
  const unsupported = (method: string) => async () => {
    throw new Error(`${method} should not be called in this test`);
  };
  const provider: IEvmProviderAdapter & {
    signer?: FakeAuthorizationSigner;
  } = {
    providerName: "fake",
    getAddress: async () => WALLET,
    getSupportedChainIds: async () => [8453],
    getNetworkContext: unsupported("getNetworkContext"),
    sendCalls: unsupported("sendCalls"),
    getTransactionReceipt: unsupported("getTransactionReceipt"),
    readContract:
      opts.readContractBalance !== undefined
        ? async () => opts.readContractBalance
        : unsupported("readContract"),
    getLogs: unsupported("getLogs"),
    getBlockNumber: unsupported("getBlockNumber"),
    signTypedData: unsupported("signTypedData"),
    async signMessage(chainId: number, message: string) {
      calls.push({ kind: "message", chainId, payload: message });
      return SIGNATURE;
    },
    async sendTransaction(chainId: number, call) {
      calls.push({ kind: "send", chainId, payload: call });
      return "0x1111111111111111111111111111111111111111";
    },
  };
  if (opts.withAuthorizationSigner) {
    provider.signer = {
      async signAuthorization(request) {
        calls.push({
          kind: "authorization",
          chainId: request.chainId,
          payload: request,
        });
        return {
          address: opts.echoAddress ?? request.contractAddress,
          nonce: request.nonce,
          chainId: request.chainId,
          yParity: "0x1",
          r: `0x${"22".repeat(32)}`,
          s: `0x${"33".repeat(32)}`,
        };
      },
    };
  }
  return provider;
}

function fakeClient(
  requests: RecordedRequest[],
  delegation: Record<string, unknown>,
  quoteExtras: Record<string, unknown> = {}
) {
  const routes = (path: string): unknown => {
    if (path.endsWith("/swap/quote")) {
      return {
        geoQuoteToken: "quote-token",
        origin: "evm",
        output: "4990000",
        feeBps: 12.5,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...quoteExtras,
      };
    }
    if (path.includes("/swap/delegation/")) {
      return delegation;
    }
    if (path.endsWith("/swap/build-geo-op")) {
      return { geoOpHash: GEO_OP_HASH, geoOpToken: "op-token" };
    }
    if (path.endsWith("/swap/build-solana-tx")) {
      return {
        unsignedTransaction: UNSIGNED_SOLANA_TX,
        geoOpToken: "sol-op-token",
      };
    }
    if (path.endsWith("/swap/submit")) {
      return { swapId: "swap-1", status: "pending" };
    }
    if (path.endsWith("/swap/submit-solana")) {
      return { swapId: "swap-1", status: "pending" };
    }
    if (path.includes("/swap/status/")) {
      return {
        swapId: "swap-1",
        status: "settled",
        originTxHash: "0xorigin",
        deliveryTxHash: "0xdelivery",
      };
    }
    throw new Error(`Unexpected path: ${path}`);
  };
  const fetchStub: typeof fetch = async (input, init) => {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const { pathname } = new URL(requestUrl);
    requests.push({
      method: init?.method ?? "GET",
      path: pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(routes(pathname)), { status: 200 });
  };
  return createGeodesicsClient({
    baseUrl: "https://fake.test",
    apiKey: "test-key",
    fetch: fetchStub,
  });
}

const request: QuoteRequest = {
  originChain: 8453,
  destinationChain: 4663,
  inputToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  outputToken: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  amount: "5000000",
  walletAddress: WALLET,
};

const delegatedResponse = {
  chainId: 8453,
  walletAddress: WALLET,
  delegated: true,
  originReady: true,
  delegatedTo: DELEGATION_TARGET,
};

const undelegatedResponse = {
  chainId: 8453,
  walletAddress: WALLET,
  delegated: false,
  originReady: false,
  delegationTarget: DELEGATION_TARGET,
  accountNonce: 7,
};

function findRequest(
  requests: RecordedRequest[],
  pathSuffix: string
): RecordedRequest | undefined {
  return requests.find((recorded) => recorded.path.endsWith(pathSuffix));
}

function bodyField(recorded: RecordedRequest | undefined, field: string): unknown {
  if (recorded === undefined || typeof recorded.body !== "object") {
    return undefined;
  }
  return recorded.body === null
    ? undefined
    : Reflect.get(recorded.body, field);
}

async function testSignsOperationHashAsRawBytes() {
  const calls: RecordedCall[] = [];
  const requests: RecordedRequest[] = [];
  const client = fakeClient(requests, delegatedResponse);

  const result = await executeSwap(
    client,
    createGeodesicsSwapSigner(fakeProvider(calls, { withAuthorizationSigner: true })),
    request,
    true
  );

  assert.strictEqual(result.status, "settled");
  assert.strictEqual(result.swapId, "swap-1");
  assert.strictEqual(result.deliveryTxHash, "0xdelivery");
  const messageSigns = calls.filter((c) => c.kind === "message");
  assert.strictEqual(messageSigns.length, 1, "signed the op hash once");
  assert.strictEqual(
    messageSigns[0].payload,
    GEO_OP_HASH,
    "signed the geoOpHash hex string (the adapter signs 0x strings as raw bytes)"
  );
  assert.strictEqual(
    calls.filter((c) => c.kind === "authorization").length,
    0,
    "no authorization on an already-delegated origin"
  );
  const submit = findRequest(requests, "/swap/submit");
  assert.ok(submit, "posted /swap/submit");
  assert.strictEqual(
    bodyField(submit, "signature"),
    SIGNATURE,
    "posted the raw signature back"
  );
  assert.strictEqual(
    bodyField(findRequest(requests, "/swap/build-geo-op"), "authorization"),
    undefined,
    "build carries no authorization when delegated"
  );
  console.log("✓ delegated origin: signs op hash, no authorization");
}

async function testFirstSwapCollectsAuthorization() {
  const calls: RecordedCall[] = [];
  const requests: RecordedRequest[] = [];
  const client = fakeClient(requests, undelegatedResponse);

  const result = await executeSwap(
    client,
    createGeodesicsSwapSigner(fakeProvider(calls, { withAuthorizationSigner: true })),
    request,
    true
  );

  assert.strictEqual(result.status, "settled");
  const authorizations = calls.filter((c) => c.kind === "authorization");
  assert.strictEqual(authorizations.length, 1, "asked the signer service once");
  assert.deepStrictEqual(
    authorizations[0].payload,
    { contractAddress: DELEGATION_TARGET, chainId: 8453, nonce: 7 },
    "authorization request carries the server-supplied target and nonce"
  );
  const build = findRequest(requests, "/swap/build-geo-op");
  assert.ok(build, "posted /swap/build-geo-op");
  assert.deepStrictEqual(
    bodyField(build, "authorization"),
    {
      chainId: 8453,
      address: getAddress(DELEGATION_TARGET),
      nonce: 7,
      yParity: 1,
      r: `0x${"22".repeat(32)}`,
      s: `0x${"33".repeat(32)}`,
    },
    "build carries the mapped authorization (request fields authoritative, yParity normalized)"
  );
  console.log(
    "✓ first swap from a new chain: authorization rides in the build"
  );
}

async function testRejectsWrongDelegationTarget() {
  const calls: RecordedCall[] = [];
  const requests: RecordedRequest[] = [];
  const client = fakeClient(requests, undelegatedResponse);

  let threw: unknown;
  try {
    await executeSwap(
      client,
      createGeodesicsSwapSigner(
        fakeProvider(calls, {
          withAuthorizationSigner: true,
          echoAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
        })
      ),
      request,
      true
    );
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof Error, "wrong-target authorization throws");
  assert.match(
    threw.message,
    /different delegation target/,
    "names the mismatch"
  );
  assert.ok(
    findRequest(requests, "/swap/build-geo-op") === undefined,
    "nothing was built or submitted"
  );
  console.log(
    "✓ signer authorizing a different target is rejected before build"
  );
}

async function testSurfacesQuotePricingAndWarnings() {
  const calls: RecordedCall[] = [];
  const requests: RecordedRequest[] = [];
  const impactMessage =
    "Estimated loss is about 6.8% of your input value including price impact and fees, proceed only if intended.";
  const client = fakeClient(requests, delegatedResponse, {
    inputUsd: "5.00",
    outputUsd: "4.66",
    priceImpactBps: -680,
    warnings: [{ code: "HIGH_PRICE_IMPACT", message: impactMessage }],
  });

  const result = await executeSwap(
    client,
    createGeodesicsSwapSigner(fakeProvider(calls, { withAuthorizationSigner: true })),
    request,
    true
  );

  assert.strictEqual(result.status, "settled");
  assert.strictEqual(
    result.priceImpactBps,
    -680,
    "the executed quote's price impact rides on the result"
  );
  assert.strictEqual(
    result.warnings,
    undefined,
    "the pre-trade impact notice does not ride a settled result"
  );
  console.log("✓ price impact rides the result; the pre-trade notice does not");
}

function quoteFixture(extras: Partial<QuoteResponse> = {}): QuoteResponse {
  return {
    geoQuoteToken: "quote-token",
    origin: "evm",
    output: "4990000",
    feeBps: 12.5,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...extras,
  };
}

function expectCliError(
  run: () => unknown,
  code: string,
  messagePattern: RegExp,
  label: string
): void {
  let threw: unknown;
  try {
    run();
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof CliError, `${label}: throws a CliError`);
  assert.strictEqual(threw.code, code, `${label}: error code`);
  assert.match(
    `${threw.message}\n${threw.recovery ?? ""}`,
    messagePattern,
    `${label}: message or recovery`
  );
}

function testResolvesTokenSymbols() {
  const usdcBase = resolveInputToken("usdc", 8453);
  assert.strictEqual(
    usdcBase.address,
    getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    "usdc on Base resolves to the canonical address"
  );
  assert.strictEqual(usdcBase.decimals, 6, "alias supplies decimals");
  assert.strictEqual(
    resolveInputToken("USDC", 8453).address,
    usdcBase.address,
    "symbol resolution is case-insensitive"
  );

  const rawAddress = resolveInputToken(
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    8453
  );
  assert.strictEqual(
    rawAddress.address,
    usdcBase.address,
    "raw addresses pass through checksummed"
  );
  assert.strictEqual(
    rawAddress.decimals,
    undefined,
    "raw addresses read decimals on-chain, not from the table"
  );

  expectCliError(
    () => resolveInputToken("pol", 137),
    "VALIDATION_ERROR",
    /native gas token/,
    "native-token input"
  );
  expectCliError(
    () => resolveInputToken("usdc", 4663),
    "VALIDATION_ERROR",
    /Symbols known on this chain: eth, usdg/,
    "unknown symbol on the chain"
  );

  assert.strictEqual(
    resolveOutputToken("usdg", 4663),
    "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    "usdg output on Robinhood Chain resolves"
  );
  assert.strictEqual(
    resolveOutputToken("eth", 8453),
    "0x0000000000000000000000000000000000000000",
    "native output resolves to the native id"
  );
  assert.strictEqual(
    resolveOutputToken("sol", 792703809),
    "11111111111111111111111111111111",
    "sol output resolves to the native SOL id"
  );
  assert.strictEqual(
    resolveOutputToken("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 792703809),
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "raw Solana mints pass through"
  );
  expectCliError(
    () => resolveOutputToken("usdc", 4663),
    "VALIDATION_ERROR",
    /Symbols known on this chain/,
    "unknown output symbol"
  );
  console.log("✓ canonical symbols resolve per chain; misses fail with hints");
}

function testGatesHighPriceImpact() {
  const impactMessage =
    "Estimated loss is about 6.8% of your input value including price impact and fees, proceed only if intended.";
  const flagged = quoteFixture({
    priceImpactBps: -680,
    warnings: [{ code: "HIGH_PRICE_IMPACT", message: impactMessage }],
  });

  assertImpactAccepted(quoteFixture(), false);
  assertImpactAccepted(flagged, true);
  expectCliError(
    () => assertImpactAccepted(flagged, false),
    "PRICE_IMPACT_HIGH",
    /Estimated loss is about 6\.8%/,
    "high-impact quote without --accept-impact"
  );
  console.log("✓ high price impact refuses without --accept-impact");
}

function fakeSolanaProvider(calls: RecordedCall[]): ISolanaProviderAdapter {
  const unsupported = (method: string) => async () => {
    throw new Error(`${method} should not be called in this test`);
  };
  const unsupportedSync =
    (method: string) =>
    (): never => {
      throw new Error(`${method} should not be called in this test`);
    };
  const provider: ISolanaProviderAdapter & {
    signTransactionViaPrivy(txBase64: string): Promise<string>;
  } = {
    providerName: "fake-solana",
    getAddress: async () => SOLANA_WALLET,
    getSupportedChainIds: async () => [501],
    getNetworkContext: unsupported("getNetworkContext"),
    getCluster: unsupported("getCluster"),
    getRpc: unsupportedSync("getRpc"),
    getSigner: unsupportedSync("getSigner"),
    signMessage: unsupported("signMessage"),
    sendInstructions: unsupported("sendInstructions"),
    async signTransactionViaPrivy(txBase64: string) {
      calls.push({ kind: "solana-tx", chainId: 501, payload: txBase64 });
      return SIGNED_SOLANA_TX;
    },
  };
  return provider;
}

const solanaRequest: QuoteRequest = {
  originChain: CHAIN_IDS.solana,
  destinationChain: 4663,
  inputToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  outputToken: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  amount: "2000000",
  walletAddress: SOLANA_WALLET,
  recipient: WALLET,
};

async function testSolanaOriginSignsWholeTransaction() {
  const calls: RecordedCall[] = [];
  const requests: RecordedRequest[] = [];
  const client = fakeClient(requests, delegatedResponse, { origin: "solana" });

  const result = await executeSwap(
    client,
    createGeodesicsSolanaSwapSigner(fakeSolanaProvider(calls)),
    solanaRequest,
    true
  );

  assert.strictEqual(result.status, "settled");
  const transactionSigns = calls.filter((call) => call.kind === "solana-tx");
  assert.strictEqual(transactionSigns.length, 1, "signed the transaction once");
  assert.strictEqual(
    transactionSigns[0].payload,
    UNSIGNED_SOLANA_TX,
    "signed the server-built unsigned transaction"
  );
  const submitSolana = findRequest(requests, "/swap/submit-solana");
  assert.ok(submitSolana, "posted /swap/submit-solana");
  assert.strictEqual(
    bodyField(submitSolana, "signedTransaction"),
    SIGNED_SOLANA_TX,
    "posted the signed transaction back"
  );
  assert.strictEqual(
    bodyField(submitSolana, "geoOpToken"),
    "sol-op-token",
    "echoed the sealed op token"
  );
  assert.ok(
    findRequest(requests, "/swap/build-geo-op") === undefined,
    "the EVM build lane was never touched"
  );
  console.log("✓ Solana origin: signs the whole prebuilt transaction");
}

function fakePipeClient(requests: RecordedRequest[]) {
  let solanaQuoteAttempts = 0;
  const routes = (
    path: string,
    body: Record<string, unknown> | undefined
  ): { status: number; payload: unknown } => {
    if (path.endsWith("/swap/quote")) {
      if (body?.originChain === CHAIN_IDS.solana) {
        solanaQuoteAttempts += 1;
        if (solanaQuoteAttempts === 1) {
          return {
            status: 409,
            payload: {
              code: "NEEDS_SOL_TOPUP",
              message: "Solana wallet holds 0 lamports (< minimum required).",
            },
          };
        }
        return {
          status: 200,
          payload: {
            geoQuoteToken: "sol-quote-token",
            origin: "solana",
            output: "1980000",
            feeBps: 12.5,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      }
      return {
        status: 200,
        payload: {
          geoQuoteToken: "pipe-quote-token",
          origin: "evm",
          output: "0.009",
          feeBps: 12.5,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    }
    if (path.includes("/swap/delegation/")) {
      return { status: 200, payload: delegatedResponse };
    }
    if (path.endsWith("/swap/build-geo-op")) {
      return {
        status: 200,
        payload: { geoOpHash: GEO_OP_HASH, geoOpToken: "op-token" },
      };
    }
    if (path.endsWith("/swap/submit")) {
      return { status: 200, payload: { swapId: "pipe-1", status: "pending" } };
    }
    if (path.includes("/swap/status/")) {
      return {
        status: 200,
        payload: { swapId: "pipe-1", status: "settled" },
      };
    }
    throw new Error(`Unexpected path: ${path}`);
  };
  const fetchStub: typeof fetch = async (input, init) => {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const { pathname } = new URL(requestUrl);
    const parsedBody =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({
      method: init?.method ?? "GET",
      path: pathname,
      body: parsedBody,
    });
    const { status, payload } = routes(pathname, parsedBody);
    return new Response(JSON.stringify(payload), { status });
  };
  return {
    client: createGeodesicsClient({
      baseUrl: "https://fake.test",
      apiKey: "test-key",
      fetch: fetchStub,
    }),
    solanaQuoteCount: () => solanaQuoteAttempts,
  };
}

async function testPreflightPipesSolThenRetries() {
  const calls: RecordedCall[] = [];
  const requests: RecordedRequest[] = [];
  const { client, solanaQuoteCount } = fakePipeClient(requests);
  const provider = fakeProvider(calls, {
    withAuthorizationSigner: true,
    readContractBalance: 2_000_000n,
  });

  const quoted = await preflightSolanaQuote(
    client,
    provider,
    solanaRequest,
    true,
    getAddress(WALLET),
    true
  );

  assert.strictEqual(quoted.origin, "solana", "the retried quote came back");
  assert.strictEqual(solanaQuoteCount(), 2, "quoted, piped, re-quoted");
  const pipeQuote = requests.find(
    (recorded) =>
      recorded.path.endsWith("/swap/quote") &&
      bodyField(recorded, "originChain") === CHAIN_IDS.base
  );
  assert.ok(pipeQuote, "the pipe quoted an EVM basis-chain origin");
  assert.strictEqual(
    bodyField(pipeQuote, "recipient"),
    SOLANA_WALLET,
    "the pipe delivers SOL to the agent's Solana wallet"
  );
  assert.strictEqual(
    calls.filter((call) => call.kind === "message").length,
    1,
    "the pipe swap signed with the EVM wallet"
  );
  assert.ok(findRequest(requests, "/swap/submit"), "the pipe swap submitted");
  console.log("✓ Solana origin without SOL: pipes a stable into SOL, retries");
}

async function testPreflightRefusesWithoutConfirmPipe() {
  const calls: RecordedCall[] = [];
  const requests: RecordedRequest[] = [];
  const { client } = fakePipeClient(requests);
  const provider = fakeProvider(calls, { readContractBalance: 2_000_000n });

  let threw: unknown;
  try {
    await preflightSolanaQuote(
      client,
      provider,
      solanaRequest,
      false,
      getAddress(WALLET),
      true
    );
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof CliError, "refusal surfaces as a CliError");
  assert.strictEqual(threw.code, "INSUFFICIENT_GAS", "typed INSUFFICIENT_GAS");
  assert.match(
    threw.recovery ?? "",
    /--confirm-pipe/,
    "the recovery names the flag"
  );
  assert.ok(
    findRequest(requests, "/swap/submit") === undefined,
    "nothing was piped or submitted"
  );
  console.log("✓ Solana origin without SOL and no --confirm-pipe: typed refusal");
}

async function testMapsSettlementTimeout() {
  let threw: unknown;
  try {
    await runGeodesics(() =>
      Promise.reject(new GeodesicsTimeoutError("swap-slow-1", "pending"))
    );
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof CliError, "timeout surfaces as a CliError");
  assert.strictEqual(threw.code, "TIMEOUT", "typed TIMEOUT");
  assert.match(
    threw.message,
    /swap-slow-1.*pending/,
    "carries the swap id and last status"
  );
  assert.match(
    threw.recovery ?? "",
    /usually still settles/,
    "the recovery says the swap may still settle"
  );
  console.log("✓ settlement-wait timeout maps to typed TIMEOUT with swap id");
}

async function testSolanaBalancePreflight() {
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const SOL_NATIVE = "11111111111111111111111111111111";
  const reads = (lamports: bigint, splBase: bigint) => ({
    getLamports: async () => lamports,
    getSplBalance: async () => splBase,
  });

  let threw: unknown;
  try {
    await assertSufficientSolanaBalance(
      reads(0n, 1_000_000n),
      SOLANA_WALLET,
      USDC_MINT,
      2_000_000n,
      6,
      true
    );
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof CliError, "insufficient SPL throws");
  assert.strictEqual(threw.code, "INSUFFICIENT_BALANCE");
  assert.match(threw.message, /holds 1 USDC on solana/, "alias-named message");

  threw = undefined;
  try {
    await assertSufficientSolanaBalance(
      reads(9_523_436n, 0n),
      SOLANA_WALLET,
      SOL_NATIVE,
      9_000_000n,
      9,
      true
    );
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof CliError, "sub-rent-exempt remainder throws");
  assert.strictEqual(threw.code, "VALIDATION_ERROR");
  assert.match(threw.message, /rent-exempt/, "names the rent rule");

  await assertSufficientSolanaBalance(
    reads(9_523_436n, 0n),
    SOLANA_WALLET,
    SOL_NATIVE,
    9_523_436n,
    9,
    true
  );
  await assertSufficientSolanaBalance(
    reads(0n, 5_000_000n),
    SOLANA_WALLET,
    USDC_MINT,
    2_000_000n,
    6,
    true
  );
  await assertSufficientSolanaBalance(
    {
      getLamports: async () => {
        throw new Error("rpc down");
      },
      getSplBalance: async () => {
        throw new Error("rpc down");
      },
    },
    SOLANA_WALLET,
    USDC_MINT,
    2_000_000n,
    6,
    true
  );
  console.log(
    "✓ Solana balance preflight: typed refusals, rent-band guard, read-failure continues"
  );
}

function testResolvesSolanaInputTokens() {
  const usdcInput = resolveSolanaInputToken("usdc");
  assert.strictEqual(
    usdcInput.token,
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "usdc resolves to the canonical mint"
  );
  assert.strictEqual(usdcInput.decimals, 6, "the alias supplies decimals");
  expectCliError(
    () => resolveSolanaInputToken("weth"),
    "VALIDATION_ERROR",
    /Solana-origin inputs: sol, usdc, usdt/,
    "unsupported Solana-origin input"
  );
  console.log("✓ Solana-origin inputs resolve via the canonical aliases");
}

async function main() {
  await testSignsOperationHashAsRawBytes();
  await testFirstSwapCollectsAuthorization();
  await testRejectsWrongDelegationTarget();
  await testSurfacesQuotePricingAndWarnings();
  testResolvesTokenSymbols();
  testGatesHighPriceImpact();
  await testSolanaOriginSignsWholeTransaction();
  await testPreflightPipesSolThenRetries();
  await testPreflightRefusesWithoutConfirmPipe();
  await testMapsSettlementTimeout();
  await testSolanaBalancePreflight();
  testResolvesSolanaInputTokens();
  console.log("\nAll acp swap bridge tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
