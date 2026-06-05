import Ajv from "ajv";

export function validateJsonSchema(input: string): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Invalid JSON. Please provide valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JSON schema must be an object.");
  }
  try {
    const ajv = new Ajv({ allErrors: true });
    ajv.compile(parsed);
  } catch (err) {
    throw new Error(
      `Invalid JSON schema: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return parsed;
}
