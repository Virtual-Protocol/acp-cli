// Run with: node --test scripts/offeringSchema.test.mjs
// Exercise Commander, schema validation and the real owner HTTP serialization.
// Only local identity/configuration and fetch are replaced; no credentials or
// sockets are used. Build from source so the test cannot use a stale dist file.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Command } from "commander";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: {
    url: { type: "string", format: "uri", description: "Public HTTPS endpoint to inspect without credentials." },
    method: { type: "string", enum: ["GET", "POST"], default: "GET", description: "Expected request method." },
  },
};
const existing = {
  id: "offering-test", name: "Endpoint check", requirements: "Existing requirements",
  deliverable: "Existing deliverable", priceValue: "1", priceType: "fixed", slaMinutes: 60,
};

const directory = await mkdtemp(new URL(".offering-schema-", import.meta.url).pathname);
let registerOfferingCommands, validateJsonSchema;
try {
  const result = await build({
    stdin: {
      contents: 'export { registerOfferingCommands } from "./src/commands/offering"; export { validateJsonSchema } from "./src/lib/validation";',
      resolveDir: process.cwd(), loader: "ts",
    },
    bundle: true, platform: "node", format: "esm", packages: "external", write: false,
    plugins: [{ name: "offline-owner-identity", setup(builder) {
      builder.onResolve({ filter: /\/activeAgent$/ }, () => ({ path: "identity", namespace: "offline" }));
      builder.onResolve({ filter: /\/config$/ }, () => ({ path: "config", namespace: "offline" }));
      builder.onLoad({ filter: /.*/, namespace: "offline" }, ({ path }) => ({ contents: path === "identity"
        ? 'export const getActiveAgentId = () => "agent-test";'
        : `export const getServerUrl = () => "https://owner.invalid";
           export const getCurrentOwnerWallet = () => "owner-test";
           export const getToken = async () => "fake-token";
           export const isTokenExpired = () => false;
           export const getRefreshToken = () => { throw Error("unexpected refresh"); };
           export const setTokens = () => { throw Error("unexpected credential write"); };`,
      }));
    } }],
  });
  const entry = `${directory}/commands.mjs`;
  await writeFile(entry, result.outputFiles[0].text);
  ({ registerOfferingCommands, validateJsonSchema } = await import(pathToFileURL(entry).href));
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function invoke(t, operation, field, value) {
  const requests = [], output = [];
  const oldExitCode = process.exitCode;
  t.after(() => { process.exitCode = oldExitCode; });
  process.exitCode = 0;
  t.mock.method(process.stdout, "write", (chunk) => { output.push(String(chunk)); return true; });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    assert.equal(new URL(url).origin, "https://owner.invalid");
    const method = init.method ?? "GET";
    requests.push({ path: new URL(url).pathname, method, body: init.body && JSON.parse(init.body) });
    const data = method === "GET"
      ? { id: "agent-test", offerings: [existing], subscriptions: [] }
      : { ...existing, ...JSON.parse(init.body) };
    return Response.json({ data });
  });
  const program = new Command().option("--json").exitOverride();
  registerOfferingCommands(program);
  const flags = operation === "create"
    ? ["--name", "Endpoint check", "--description", "Inspect a public endpoint", "--price-type", "fixed",
       "--price-value", "1", "--sla-minutes", "60", "--no-required-funds", "--no-hidden",
       "--subscription-ids", "", `--${field === "requirements" ? "deliverable" : "requirements"}`, "Plain description"]
    : ["--offering-id", existing.id];
  await program.parseAsync(["node", "acp", "--json", "offering", operation, ...flags, `--${field}`, value]);
  return { requests, output: output.map(line => JSON.parse(line)), exitCode: process.exitCode };
}

for (const operation of ["create", "update"]) {
  for (const field of ["requirements", "deliverable"]) {
    test(`${operation} ${field}: URI schema reaches owner HTTP as an object with enforced constraints`, async t => {
      const result = await invoke(t, operation, field, JSON.stringify(schema));
      assert.equal(result.exitCode, 0);
      const writes = result.requests.filter(r => r.method !== "GET");
      assert.equal(writes.length, 1);
      assert.equal(writes[0].method, operation === "create" ? "POST" : "PUT");
      assert.equal(writes[0].path, `/agents/agent-test/offerings${operation === "update" ? "/offering-test" : ""}`);
      assert.deepEqual(writes[0].body[field], schema);
      if (operation === "update") assert.deepEqual(Object.keys(writes[0].body), [field]);
      const ajv = new Ajv({ allErrors: true });
      addFormats(ajv);
      const validate = ajv.compile(writes[0].body[field]);
      for (const input of [{ url: "https://example.com" }, { url: "https://example.com", method: "GET" },
        { url: "https://example.com", method: "POST" }, { url: "http://example.com" }]) {
        assert.equal(validate(input), true, JSON.stringify(input));
      }
      for (const input of [{}, { method: "GET" }, { url: "not a uri" }, { url: "https://example.com", method: "PUT" },
        { url: "https://example.com", method: "get" }, { url: "https://example.com", extra: true }, null, "scalar"]) {
        assert.equal(validate(input), false, JSON.stringify(input));
      }
    });
    for (const invalid of ['{"type":"invalid"}', '{"type":"object","properties":{"url":{"type":"string","format":"unknown-format"}}}', '{"type":"object","required":"url"}']) {
      test(`${operation} ${field}: invalid object ${invalid} refuses before owner HTTP`, async t => {
        const result = await invoke(t, operation, field, invalid);
        assert.equal(result.exitCode, 1);
        assert.deepEqual(result.requests, []);
        assert.match(result.output[0].error, /Invalid JSON schema/);
      });
    }
    for (const value of ["Plain description", "{not JSON", "null", "7", "true", '"text"', "[]"]) {
      test(`${operation} ${field}: preserves description input ${value}`, async t => {
        const result = await invoke(t, operation, field, value);
        assert.equal(result.exitCode, 0);
        assert.equal(result.requests.find(r => r.method !== "GET").body[field], value);
      });
    }
    test(`${operation} ${field}: whitespace refuses before owner HTTP`, async t => {
      const result = await invoke(t, operation, field, "   ");
      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.requests, []);
      assert.match(result.output[0].error, /cannot be empty/);
    });
  }
}

test("shared validator accepts standard formats and rejects malformed schema inputs", () => {
  assert.deepEqual(validateJsonSchema(JSON.stringify(schema)), schema);
  for (const format of ["uri", "email", "date-time", "uuid"]) {
    const formatted = { type: "string", format };
    assert.deepEqual(validateJsonSchema(JSON.stringify(formatted)), formatted);
  }
  for (const value of ["not JSON", "null", "[]", "true", "7"]) assert.throws(() => validateJsonSchema(value));
  assert.deepEqual(validateJsonSchema("{}"), {});
});
