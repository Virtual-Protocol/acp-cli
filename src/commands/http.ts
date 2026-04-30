import type { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { Mppx, tempo as mppTempo } from "mppx/client";
import { createClient, custom, type Address, type Call, type Hex } from "viem";
import { tempo as tempoChain } from "viem/chains";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { ClientEvmSigner } from "@x402/evm";
import {
  x402Client,
  x402HTTPClient,
  decodePaymentResponseHeader,
} from "@x402/fetch";
import type { IEvmProviderAdapter } from "@virtuals-protocol/acp-node-v2";
import { createProviderAdapter, getWalletAddress } from "../lib/agentFactory";
import { CliError } from "../lib/errors";
import { isJson, outputError, outputResult } from "../lib/output";

type PaidHttpProtocol = "auto" | "x402" | "mpp";

type HttpOptions = {
  method?: string;
  header?: string[];
  data?: string;
  dataFile?: string;
  jsonBody?: string;
  protocol?: PaidHttpProtocol;
  includeHeaders?: boolean;
  output?: string;
};

type RequestParts = {
  init: RequestInit;
};

export function registerHttpCommands(program: Command): void {
  program
    .command("http <url>")
    .description("Call paid HTTP endpoints with the active agent wallet")
    .option("-X, --method <method>", "HTTP method", "GET")
    .option("-H, --header <header...>", "HTTP header, e.g. 'Name: value'")
    .option("-d, --data <body>", "Raw request body")
    .option("--data-file <path>", "Read request body from a file")
    .option(
      "--json-body <json>",
      "JSON request body; sets content-type if absent",
    )
    .option(
      "--protocol <protocol>",
      "Payment protocol: auto, x402, or mpp",
      "auto",
    )
    .option("--include-headers", "Include response headers in CLI output")
    .option("--output <path>", "Write response body to a file")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  acp http https://api.example.com/paid-resource",
        '  acp http -X POST --json-body \'{"prompt":"hello"}\' https://api.example.com/jobs',
        "",
        "This is separate from ACP job lifecycle commands. It is a generic paid HTTP client for x402/MPP endpoints.",
      ].join("\n"),
    )
    .action(async (url: string, opts: HttpOptions, cmd) => {
      const json = isJson(cmd);
      try {
        const protocol = parseProtocol(opts.protocol);
        const request = buildRequest(opts);
        const response = await executePaidHttp(url, request.init, protocol);
        await writeResponse(response, {
          json,
          includeHeaders: opts.includeHeaders === true,
          outputPath: opts.output,
          protocol,
        });
      } catch (err) {
        outputError(json, err instanceof Error ? err : String(err));
      }
    });
}

function parseProtocol(value: string | undefined): PaidHttpProtocol {
  const protocol = (value ?? "auto").toLowerCase();
  if (protocol === "auto" || protocol === "x402" || protocol === "mpp") {
    return protocol;
  }
  throw new CliError(
    `Unsupported payment protocol: ${value}`,
    "VALIDATION_ERROR",
    "Use --protocol auto, --protocol x402, or --protocol mpp.",
  );
}

function buildRequest(opts: HttpOptions): RequestParts {
  const method = (opts.method ?? "GET").toUpperCase();
  const headers = parseHeaders(opts.header ?? []);
  const bodyValues = [
    opts.data !== undefined,
    opts.dataFile !== undefined,
    opts.jsonBody !== undefined,
  ].filter(Boolean).length;

  if (bodyValues > 1) {
    throw new CliError(
      "Only one request body option can be used.",
      "VALIDATION_ERROR",
      "Use one of --data, --data-file, or --json-body.",
    );
  }

  let body: string | undefined;
  if (opts.data !== undefined) {
    body = opts.data;
  } else if (opts.dataFile !== undefined) {
    body = readFileSync(opts.dataFile, "utf8");
  } else if (opts.jsonBody !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.jsonBody);
    } catch {
      throw new CliError(
        "Invalid JSON in --json-body.",
        "VALIDATION_ERROR",
        "Provide a valid JSON string.",
      );
    }
    body = JSON.stringify(parsed);
    if (!hasHeader(headers, "content-type")) {
      headers.set("content-type", "application/json");
    }
  }

  if (body !== undefined && method === "GET") {
    throw new CliError(
      "GET requests cannot include a body.",
      "VALIDATION_ERROR",
      "Use -X POST, -X PUT, or another method when sending a body.",
    );
  }

  return {
    init: {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    },
  };
}

function parseHeaders(values: string[]): Headers {
  const headers = new Headers();
  for (const value of values) {
    const separator = value.indexOf(":");
    if (separator <= 0) {
      throw new CliError(
        `Invalid header: ${value}`,
        "VALIDATION_ERROR",
        "Headers must use the format 'Name: value'.",
      );
    }
    headers.append(
      value.slice(0, separator).trim(),
      value.slice(separator + 1).trim(),
    );
  }
  return headers;
}

function hasHeader(headers: Headers, name: string): boolean {
  return headers.has(name);
}

function fetchWithHeaders(
  url: string,
  init: RequestInit,
  headers: Record<string, string>,
): Promise<Response> {
  const merged = new Headers(init.headers);
  for (const [key, value] of Object.entries(headers)) {
    merged.set(key, value);
  }
  return fetch(url, { ...init, headers: merged });
}

function withHeader(
  headers: HeadersInit | undefined,
  name: string,
  value: string,
): Headers {
  const merged = new Headers(headers);
  if (!merged.has(name)) merged.set(name, value);
  return merged;
}

function withAuthorizationHeader(
  headers: HeadersInit | undefined,
  credential: string,
): Headers {
  const merged = new Headers(headers);
  merged.delete("authorization");
  merged.set("Authorization", credential);
  return merged;
}

async function executePaidHttp(
  url: string,
  init: RequestInit,
  protocol: PaidHttpProtocol,
): Promise<Response> {
  if (protocol === "x402") return executeX402Http(url, init);
  if (protocol === "mpp") return executeMppHttp(url, init);

  const probe = await fetch(url, init);
  if (probe.status !== 402) return probe;

  const detected = await detectPaymentProtocol(probe);
  if (detected === "x402") return executeX402Http(url, init, probe);
  if (detected === "mpp") return executeMppHttp(url, init, probe);

  throw new CliError(
    "The endpoint returned 402 but no supported payment protocol was detected.",
    "API_ERROR",
    "Use --protocol x402 or --protocol mpp if the endpoint uses non-standard headers.",
  );
}

async function detectPaymentProtocol(
  response: Response,
): Promise<Exclude<PaidHttpProtocol, "auto"> | null> {
  const wwwAuthenticate = response.headers.get("www-authenticate");
  if (wwwAuthenticate?.match(/\bPayment\b/i)) return "mpp";

  if (
    response.headers.has("payment-required") ||
    response.headers.has("x-payment-required")
  ) {
    return "x402";
  }

  try {
    const body = await response.clone().json();
    if (
      body &&
      typeof body === "object" &&
      ("x402Version" in body ||
        "paymentRequirements" in body ||
        "accepts" in body)
    ) {
      return "x402";
    }
  } catch {
    // Non-JSON 402 responses are common. Header detection above handles MPP.
  }

  return null;
}

async function executeX402Http(
  url: string,
  init: RequestInit,
  firstResponse?: Response,
): Promise<Response> {
  const { client, httpClient } = await createX402Client();
  const response = firstResponse ?? (await fetch(url, init));
  if (response.status !== 402) return response;

  const paymentRequired = await parseX402PaymentRequired(httpClient, response);
  const hookHeaders = await httpClient.handlePaymentRequired(paymentRequired);
  if (hookHeaders) {
    const hookResponse = await fetchWithHeaders(url, init, hookHeaders);
    if (hookResponse.status !== 402) return hookResponse;
  }

  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const paymentHeaders =
    httpClient.encodePaymentSignatureHeader(paymentPayload);
  return fetchWithHeaders(url, init, {
    ...paymentHeaders,
    "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
  });
}

async function parseX402PaymentRequired(
  httpClient: x402HTTPClient,
  response: Response,
) {
  try {
    let body: unknown;
    try {
      const responseText = await response.clone().text();
      if (responseText) body = JSON.parse(responseText);
    } catch {
      // Header-only x402 responses are valid.
    }

    return httpClient.getPaymentRequiredResponse(
      (name: string) => response.headers.get(name),
      body,
    );
  } catch (error) {
    throw new Error(
      `Failed to parse x402 payment requirements: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
}

async function createX402Client(): Promise<{
  client: x402Client;
  httpClient: x402HTTPClient;
}> {
  const provider = await createProviderAdapter();
  const signer = createX402Signer(provider);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  return { client, httpClient: new x402HTTPClient(client) };
}

function createX402Signer(provider: IEvmProviderAdapter): ClientEvmSigner {
  const address = getWalletAddress() as `0x${string}`;
  return {
    address,
    async signTypedData(message) {
      const chainId = Number(message.domain.chainId);
      if (!Number.isFinite(chainId)) {
        throw new CliError(
          "x402 payment request did not include an EIP-712 chainId.",
          "VALIDATION_ERROR",
          "The endpoint must include a chainId in the payment typed-data domain.",
        );
      }
      return (await provider.signTypedData(chainId, message)) as `0x${string}`;
    },
  };
}

async function executeMppHttp(
  url: string,
  init: RequestInit,
  firstResponse?: Response,
): Promise<Response> {
  const mpp = await createMppHandler();
  const response =
    firstResponse ??
    (await fetch(url, {
      ...init,
      headers: withHeader(init.headers, "Accept-Payment", "tempo/charge"),
    }));
  if (response.status !== 402) return response;

  const credential = await mpp.createCredential(response);
  return fetch(url, {
    ...init,
    headers: withAuthorizationHeader(init.headers, credential),
  });
}

async function createMppHandler() {
  const provider = await createProviderAdapter();
  const address = getWalletAddress() as Address;
  const clientsByChainId = new Map<
    number,
    ReturnType<typeof createMppClient>
  >();
  const mpp = Mppx.create({
    fetch,
    polyfill: false,
    methods: [
      mppTempo({
        account: createMppAccount(provider, address) as never,
        getClient: ({ chainId }) => {
          const resolvedChainId = Number(chainId ?? tempoChain.id);
          const existing = clientsByChainId.get(resolvedChainId);
          if (existing) return existing;

          const client = createMppClient(provider, address, resolvedChainId);
          clientsByChainId.set(resolvedChainId, client);
          return client;
        },
        mode: "push",
      }),
    ],
  });
  return mpp;
}

function createMppAccount(provider: IEvmProviderAdapter, address: Address) {
  return {
    address,
    type: "local",
    async signTypedData(args: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<Hex> {
      const chainId = Number(args.domain.chainId);
      if (!Number.isFinite(chainId)) {
        throw new CliError(
          "MPP payment request did not include an EIP-712 chainId.",
          "VALIDATION_ERROR",
          "The endpoint must include a chainId in the payment challenge.",
        );
      }
      return (await provider.signTypedData(chainId, args)) as Hex;
    },
  } as const;
}

function createMppClient(
  provider: IEvmProviderAdapter,
  address: Address,
  chainId: number = tempoChain.id,
) {
  const chain = { ...tempoChain, id: chainId };
  const sentCalls = new Map<string, { chainId: number; hashes: Hex[] }>();
  const client = createClient({
    account: createMppAccount(provider, address) as never,
    chain,
    transport: custom({
      async request({ method }) {
        throw new Error(
          `MPP wallet operation ${method} is not available through the generic RPC transport.`,
        );
      },
    }),
  });

  return Object.assign(client, {
    async sendCalls({ calls }: { calls: Call[] }) {
      await assertProviderSupportsChain(provider, chain.id);
      const result = await provider.sendCalls(chain.id, calls);
      const hashes = (Array.isArray(result) ? result : [result]) as Hex[];
      const id = `acp:${chain.id}:${hashes.join(",")}`;
      sentCalls.set(id, { chainId: chain.id, hashes });
      return { id };
    },

    async getCallsStatus({ id }: { id: string }) {
      const tracked = sentCalls.get(id);
      if (!tracked) {
        throw new Error(`Unknown ACP wallet call bundle: ${id}`);
      }

      const receipts = await Promise.all(
        tracked.hashes.map(async (hash) => {
          try {
            return await provider.getTransactionReceipt(tracked.chainId, hash);
          } catch {
            return null;
          }
        }),
      );

      if (receipts.some((receipt) => receipt === null)) {
        return {
          atomic: false,
          chainId: tracked.chainId,
          receipts: receipts.filter(Boolean),
          status: "pending",
          statusCode: 100,
          version: "2.0.0",
        };
      }

      return {
        atomic: false,
        chainId: tracked.chainId,
        receipts,
        status: "success",
        statusCode: 200,
        version: "2.0.0",
      };
    },
  });
}

async function assertProviderSupportsChain(
  provider: IEvmProviderAdapter,
  chainId: number,
): Promise<void> {
  const supported = await provider.getSupportedChainIds();
  if (!supported.includes(chainId)) {
    throw new CliError(
      `The active ACP wallet adapter does not support MPP Tempo chain ${chainId}.`,
      "VALIDATION_ERROR",
      `Supported chains: ${supported.join(", ")}. MPP Tempo payments need ACP wallet support for chain ${chainId}.`,
    );
  }
}

async function writeResponse(
  response: Response,
  opts: {
    json: boolean;
    includeHeaders: boolean;
    outputPath?: string;
    protocol: PaidHttpProtocol;
  },
): Promise<void> {
  const body = await response.text();
  if (opts.outputPath) {
    writeFileSync(opts.outputPath, body);
  }

  const headers = headersToObject(response.headers);
  const paymentResponse = decodeX402PaymentResponse(response.headers);

  if (!response.ok) {
    process.exitCode = 1;
  }

  if (opts.json) {
    outputResult(true, {
      status: response.status,
      ok: response.ok,
      protocol: opts.protocol,
      headers: opts.includeHeaders ? headers : undefined,
      paymentResponse,
      output: opts.outputPath,
      body: opts.outputPath ? undefined : parseBody(body),
    });
    return;
  }

  if (opts.includeHeaders) {
    console.log(`HTTP ${response.status} ${response.statusText}`);
    for (const [key, value] of Object.entries(headers)) {
      console.log(`${key}: ${value}`);
    }
    console.log("");
  }

  if (paymentResponse) {
    console.error(`Payment-Response: ${JSON.stringify(paymentResponse)}`);
  }

  if (!opts.outputPath) {
    process.stdout.write(body);
    if (body && !body.endsWith("\n")) process.stdout.write("\n");
  } else {
    outputResult(false, {
      status: response.status,
      ok: response.ok,
      output: opts.outputPath,
    });
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function decodeX402PaymentResponse(headers: Headers): unknown | undefined {
  const header =
    headers.get("payment-response") ?? headers.get("x-payment-response");
  if (!header) return undefined;

  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return header;
  }
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
