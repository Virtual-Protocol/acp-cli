import { ApiClient } from "./client";

// Mirrors the backend PolicyChainType enum. Policies are only attachable to
// EVM signers today, so ETHEREUM is the only value the CLI creates.
export type PolicyChainType = "ETHEREUM" | "SOLANA" | "TRON" | "SUI";

// One entry in a policy's contract allowlist. The optional `name` is a
// human label; `address` is the (checksummed) contract/wallet address the
// signer is permitted to interact with.
export interface ContractEntry {
  name?: string | null;
  address: string;
}

// A custom wallet policy as stored by the backend.
export interface Policy {
  id: string;
  policyId: string;
  userId: string;
  chainType: PolicyChainType;
  name: string;
  contracts: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface CreatePolicyBody {
  name: string;
  contracts: ContractEntry[];
}

export interface CreatePolicyResponse {
  message: string;
  data: { policy: Policy; rules: unknown[] };
}

export interface ListPoliciesResponse {
  data: Policy[];
  meta?: {
    pagination?: { limit?: number; total?: number; nextCursor?: string | null };
  };
}

export interface GetPolicyResponse {
  data: { policy: Policy; remote: unknown };
}

// A platform-managed (global) policy preset, e.g. DENY_ALL / ACP_ONLY.
export interface GlobalPolicy {
  name: string;
  policyId: string;
}

export interface GlobalPoliciesResponse {
  data: GlobalPolicy[];
}

export interface AuthorizationKey {
  public_key: string;
  display_name: string | null;
}

// A signer (Privy key quorum) attached to an agent wallet. `policy_ids` holds
// the Privy policy ids currently overriding this signer (empty/null = no policy).
export interface WalletSigner {
  id: string;
  display_name: string;
  authorization_keys: AuthorizationKey[];
  policy_ids: string[] | null;
}

export interface WalletSignersResponse {
  message: string;
  data: WalletSigner[];
}

export class PolicyApi {
  private client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  async createPolicy(body: CreatePolicyBody): Promise<CreatePolicyResponse> {
    return this.client.post<CreatePolicyResponse>("/policies", body);
  }

  async listPolicies(opts?: {
    limit?: number;
    cursor?: string;
    chainType?: PolicyChainType;
  }): Promise<ListPoliciesResponse> {
    const params: Record<string, string> = {};
    if (opts?.limit !== undefined) params.limit = String(opts.limit);
    if (opts?.cursor) params.cursor = opts.cursor;
    if (opts?.chainType) params.chainType = opts.chainType;
    return this.client.get<ListPoliciesResponse>("/policies", params);
  }

  async getPolicy(id: string): Promise<GetPolicyResponse> {
    return this.client.get<GetPolicyResponse>(`/policies/${id}`);
  }

  async getGlobalPolicies(): Promise<GlobalPoliciesResponse> {
    return this.client.get<GlobalPoliciesResponse>("/common/policies/global");
  }

  async getWalletSigners(agentId: string): Promise<WalletSignersResponse> {
    return this.client.get<WalletSignersResponse>(`/agents/${agentId}/signers`);
  }
}
