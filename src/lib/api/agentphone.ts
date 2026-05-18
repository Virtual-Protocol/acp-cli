import { CliError } from "../errors";

const DEFAULT_BASE_URL = "https://api.agentphone.ai";
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface AgentPhoneAgent {
  id: string;
  name: string;
  description?: string | null;
  voiceMode: "webhook" | "hosted";
  systemPrompt?: string | null;
  voice?: string | null;
  webhookUrl?: string | null;
  numbers?: AgentPhoneNumber[];
  createdAt?: string;
}

export interface AgentPhoneNumber {
  id: string;
  phoneNumber: string;
  country?: string;
  agentId?: string | null;
  status?: string;
  createdAt?: string;
}

export interface AgentPhoneMessage {
  id: string;
  conversationId?: string;
  direction?: "inbound" | "outbound";
  from?: string;
  to?: string;
  body?: string;
  createdAt?: string;
}

export interface AgentPhoneConversation {
  id: string;
  participant?: string;
  numberId?: string;
  lastMessageAt?: string;
  messageCount?: number;
  preview?: string;
}

export interface AgentPhoneCall {
  id: string;
  agentId?: string;
  fromNumber?: string;
  toNumber?: string;
  status?: string;
  durationSeconds?: number;
  createdAt?: string;
}

export interface AgentPhoneTranscriptTurn {
  role: "user" | "agent" | string;
  text: string;
  at?: string;
}

export interface AgentPhoneTranscript {
  callId: string;
  turns: AgentPhoneTranscriptTurn[];
}

interface ListEnvelope<T> {
  data?: T[];
  items?: T[];
  total?: number;
  hasMore?: boolean;
}

export class AgentPhoneError extends Error {
  status: number;
  details: unknown;
  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class AgentPhoneClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(opts?: { apiKey?: string; baseUrl?: string }) {
    const apiKey = opts?.apiKey ?? process.env.AGENTPHONE_API_KEY;
    if (!apiKey) {
      throw new CliError(
        "AGENTPHONE_API_KEY not set.",
        "NOT_AUTHENTICATED",
        "Get a key at https://agentphone.ai and run `export AGENTPHONE_API_KEY=ap_...`."
      );
    }
    this.apiKey = apiKey;
    this.baseUrl =
      opts?.baseUrl ?? process.env.AGENTPHONE_BASE_URL ?? DEFAULT_BASE_URL;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }

    let lastErr: unknown;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body: payload });
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) return (await res.json()) as T;
        return (await res.text()) as unknown as T;
      }

      if (RETRY_STATUSES.has(res.status) && attempt < maxAttempts) {
        await sleep(backoffMs(attempt, res.headers.get("retry-after")));
        continue;
      }

      const errBody = await safeJson(res);
      throw new AgentPhoneError(
        formatErrorMessage(res.status, errBody),
        res.status,
        errBody
      );
    }
    throw lastErr ?? new Error("AgentPhone request failed");
  }

  // ---------- Agents ----------
  createAgent(body: {
    name: string;
    description?: string;
    voiceMode?: "webhook" | "hosted";
    systemPrompt?: string;
    voice?: string;
    webhookUrl?: string;
  }): Promise<AgentPhoneAgent> {
    return this.request("POST", "/v1/agents", body);
  }

  getAgent(agentId: string): Promise<AgentPhoneAgent> {
    return this.request("GET", `/v1/agents/${agentId}`);
  }

  updateAgent(
    agentId: string,
    body: Partial<{
      name: string;
      description: string;
      voiceMode: "webhook" | "hosted";
      systemPrompt: string;
      voice: string;
      webhookUrl: string;
    }>
  ): Promise<AgentPhoneAgent> {
    return this.request("PATCH", `/v1/agents/${agentId}`, body);
  }

  // ---------- Numbers ----------
  createNumber(body: {
    country?: string;
    areaCode?: string;
    agentId?: string;
  }): Promise<AgentPhoneNumber> {
    return this.request("POST", "/v1/numbers", body);
  }

  attachNumber(
    agentId: string,
    numberId: string
  ): Promise<AgentPhoneNumber> {
    return this.request("POST", `/v1/agents/${agentId}/numbers`, {
      numberId,
    });
  }

  async listNumbers(opts?: {
    limit?: number;
    offset?: number;
  }): Promise<AgentPhoneNumber[]> {
    const qs = buildQs(opts);
    const res = await this.request<ListEnvelope<AgentPhoneNumber>>(
      "GET",
      `/v1/numbers${qs}`
    );
    return res.data ?? res.items ?? [];
  }

  // ---------- Messages / conversations ----------
  sendMessage(body: {
    from: string;
    to: string;
    body: string;
    mediaUrls?: string[];
  }): Promise<AgentPhoneMessage> {
    // AgentPhone API uses snake_case for media_urls.
    const payload: Record<string, unknown> = {
      from: body.from,
      to: body.to,
      body: body.body,
    };
    if (body.mediaUrls) payload.media_urls = body.mediaUrls;
    return this.request("POST", "/v1/messages", payload);
  }

  async listConversations(opts?: {
    limit?: number;
    offset?: number;
  }): Promise<AgentPhoneConversation[]> {
    const qs = buildQs(opts);
    const res = await this.request<ListEnvelope<AgentPhoneConversation>>(
      "GET",
      `/v1/conversations${qs}`
    );
    return res.data ?? res.items ?? [];
  }

  async listMessages(
    conversationId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<AgentPhoneMessage[]> {
    const qs = buildQs(opts);
    const res = await this.request<ListEnvelope<AgentPhoneMessage>>(
      "GET",
      `/v1/conversations/${conversationId}/messages${qs}`
    );
    return res.data ?? res.items ?? [];
  }

  // ---------- Calls ----------
  createCall(body: {
    agentId: string;
    toNumber: string;
    fromNumberId?: string;
    greeting?: string;
  }): Promise<AgentPhoneCall> {
    return this.request("POST", "/v1/calls", body);
  }

  async listCalls(opts?: {
    limit?: number;
    offset?: number;
  }): Promise<AgentPhoneCall[]> {
    const qs = buildQs(opts);
    const res = await this.request<ListEnvelope<AgentPhoneCall>>(
      "GET",
      `/v1/calls${qs}`
    );
    return res.data ?? res.items ?? [];
  }

  getTranscript(callId: string): Promise<AgentPhoneTranscript> {
    return this.request("GET", `/v1/calls/${callId}/transcript`);
  }
}

function buildQs(opts?: { limit?: number; offset?: number }): string {
  if (!opts) return "";
  const parts: string[] = [];
  if (opts.limit !== undefined) parts.push(`limit=${opts.limit}`);
  if (opts.offset !== undefined) parts.push(`offset=${opts.offset}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n) && n > 0) return Math.min(n * 1000, 5000);
  }
  return Math.min(500 * 2 ** (attempt - 1), 2000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try {
      return await res.text();
    } catch {
      return null;
    }
  }
}

function formatErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.errorMessage === "string") return b.errorMessage;
    if (typeof b.message === "string") return b.message;
    if (Array.isArray(b.details) && b.details.length > 0) {
      const first = b.details[0] as Record<string, unknown>;
      if (typeof first.msg === "string") return first.msg;
    }
    if (typeof b.detail === "string") return b.detail;
  }
  if (typeof body === "string" && body.length > 0) return body;
  return `AgentPhone API error (HTTP ${status})`;
}
