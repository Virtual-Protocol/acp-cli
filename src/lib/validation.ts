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

/**
 * Returns true if `input` is an http(s) LinkedIn personal-profile URL of the
 * form `linkedin.com/in/<slug>` (country subdomains like `sg.linkedin.com`,
 * optional `www.`, and a trailing slash are allowed; query/hash are ignored).
 * Company pages, the bare domain, and non-LinkedIn URLs are rejected.
 */
export function isValidLinkedInProfileUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return false;
  return /^\/in\/[^/\s]+\/?$/.test(url.pathname);
}
