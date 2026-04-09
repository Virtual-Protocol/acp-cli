import { ApiClient } from "./client";

export interface AddSignerResponse {
  message: string;
  data: { url: string; requestId: string };
}

export interface GetSignerStatusResponse {
  message: string;
  data: { status: "completed" | "pending" | null };
}

export interface AgentOffering {
  id: string;
  agentId: string;
  name: string;
  description: string;
  requirements: Record<string, unknown> | string;
  deliverable: Record<string, unknown> | string;
  slaMinutes: number;
  priceType: string;
  priceValue: string;
  requiredFunds: boolean;
  isHidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOfferingBody {
  name: string;
  description: string;
  deliverable: Record<string, unknown> | string;
  requirements: Record<string, unknown> | string;
  slaMinutes: number;
  priceType: "fixed" | "percentage";
  priceValue: number;
  requiredFunds?: boolean;
  isHidden?: boolean;
}

export type UpdateOfferingBody = Partial<CreateOfferingBody>;

interface OfferingResponse {
  message: string;
  data: AgentOffering;
}

interface DeleteOfferingResponse {
  message: string;
}

export interface AgentResource {
  id: string;
  agentId: string;
  name: string;
  description: string;
  url: string;
  params: Record<string, unknown>;
  isHidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateResourceBody {
  name: string;
  description: string;
  url: string;
  params: Record<string, unknown>;
  hidden?: boolean;
}

export type UpdateResourceBody = Partial<CreateResourceBody>;

interface ResourceResponse {
  message: string;
  data: AgentResource;
}

interface DeleteResourceResponse {
  message: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  userId: string;
  walletAddress: string;
  solWalletAddress: string | null;
  role: string;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string;
  offerings: AgentOffering[];
  resources: AgentResource[];
  isHidden: boolean;
  walletProviders: {
    provider: string;
    metadata: {
      walletId: string;
    };
  }[];
  chains: {
    chainId: number;
    tokenAddress?: string;
    acpV2AgentId?: number;
  }[];
}

interface AgentListResponse {
  data: Agent[];
  meta: {
    pagination: {
      total: number;
      page: number;
      pageSize: number;
      pageCount: number;
    };
  };
}

interface AgentCreateResponse {
  message: string;
  data: Agent;
}

interface AddQuorumResponse {
  message: string;
  data: string; // keyQuorumId
}

export interface BrowseAgent {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  userId: string;
  walletAddress: string;
  solWalletAddress: string | null;
  role: string;
  cluster: string | null;
  tag: string | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
  rating: number | null;
  isHidden: boolean;
  chains: {
    id: string;
    agentId: string;
    chainId: number;
    tokenAddress: string;
    virtualAgentId: string | null;
    acpV2AgentId: number | null;
    symbol: string;
    active: boolean;
    erc8004AgentId: number | null;
  }[];
  offerings: {
    id: string;
    agentId: string;
    name: string;
    description: string;
    requirements: unknown;
    deliverable: unknown;
    slaMinutes: number;
    priceType: string;
    priceValue: string;
    requiredFunds: boolean;
    isHidden: boolean;
    createdAt: string;
    updatedAt: string;
  }[];
  resources: {
    id: string;
    name: string;
    description: string;
    params: unknown;
    url: string;
  }[];
}

interface AgentBrowseResponse {
  data: BrowseAgent[];
}

export const MigrationStatus = {
  PENDING: "PENDING",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
} as const;

export type MigrationStatus =
  (typeof MigrationStatus)[keyof typeof MigrationStatus];

export interface LegacyAgent {
  id: number;
  name: string;
  walletAddress: string;
  migrationStatus: MigrationStatus;
}

export interface TokenizeStatusResponse {
  hasTokenized: boolean;
  hasPaid: boolean;
  paymentToken: string;
  paymentAmount: string;
  paymentData: string;
}

export interface TokenizeResponse {
  id: number;
  name: string;
  symbol: string;
  status: string;
  factory: string;
  launchedAt: string;
  preToken: string;
  taxRecipient: string;
}

export interface UpdateAgentBody {
  name: string;
  description: string;
  image: string;
  isHidden: boolean;
}

export class AgentApi {
  private client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  async getById(id: string): Promise<Agent> {
    const res = await this.client.get<{ data: Agent }>(`/agents/${id}`);
    return res.data;
  }

  async list(page?: number, pageSize?: number): Promise<AgentListResponse> {
    const params: Record<string, string> = {};
    if (page !== undefined) params.page = String(page);
    if (pageSize !== undefined) params.pageSize = String(pageSize);
    return this.client.get<AgentListResponse>("/agents", params);
  }

  async create(
    name: string,
    description: string,
    image?: string
  ): Promise<Agent> {
    const body: Record<string, unknown> = { name, description, role: "HYBRID" };
    if (image) body.image = image;
    const res = await this.client.post<AgentCreateResponse>("/agents", body);
    return res.data;
  }

  async update(
    agentId: string,
    body: Partial<UpdateAgentBody>
  ): Promise<Agent> {
    const res = await this.client.put<{ data: Agent }>(
      `/agents/${agentId}`,
      body
    );
    return res.data;
  }

  async addQuorum(
    agentId: string,
    publicKey: string
  ): Promise<AddQuorumResponse> {
    return this.client.post<AddQuorumResponse>(`/agents/${agentId}/quorum`, {
      publicKey,
    });
  }

  async browse(
    query?: string,
    chainIds?: number[],
    opts?: {
      sortBy?: string[];
      topK?: number;
      isOnline?: string;
      cluster?: string;
    }
  ): Promise<AgentBrowseResponse> {
    const params: Record<string, string> = {};
    if (query) params.query = query;
    if (chainIds && chainIds.length > 0) params.chainIds = chainIds.join(",");
    if (opts?.sortBy && opts.sortBy.length > 0)
      params.sortBy = opts.sortBy.join(",");
    if (opts?.topK !== undefined) params.topK = String(opts.topK);
    if (opts?.isOnline) params.isOnline = opts.isOnline;
    if (opts?.cluster) params.cluster = opts.cluster;
    return this.client.get<AgentBrowseResponse>("/agents/search", params);
  }

  async addSignerWithUrl(agentId: string): Promise<AddSignerResponse> {
    return this.client.post(`/agents/${agentId}/signer`, {});
  }

  async getSignerStatus(
    agentId: string,
    requestId: string
  ): Promise<GetSignerStatusResponse> {
    return this.client.get<GetSignerStatusResponse>(
      `/agents/${agentId}/signer?requestId=${requestId}`
    );
  }

  async getTokenizeDetails(
    agentId: string,
    chainId: number
  ): Promise<TokenizeStatusResponse> {
    return this.client.get<TokenizeStatusResponse>(
      `/agents/${agentId}/tokenize?chainId=${chainId}`
    );
  }

  async createOffering(
    agentId: string,
    body: CreateOfferingBody
  ): Promise<AgentOffering> {
    const res = await this.client.post<OfferingResponse>(
      `/agents/${agentId}/offerings`,
      body
    );
    return res.data;
  }

  async updateOffering(
    agentId: string,
    offeringId: string,
    body: UpdateOfferingBody
  ): Promise<AgentOffering> {
    const res = await this.client.put<OfferingResponse>(
      `/agents/${agentId}/offerings/${offeringId}`,
      body
    );
    return res.data;
  }

  async deleteOffering(
    agentId: string,
    offeringId: string
  ): Promise<DeleteOfferingResponse> {
    return this.client.delete<DeleteOfferingResponse>(
      `/agents/${agentId}/offerings/${offeringId}`
    );
  }

  async createResource(
    agentId: string,
    body: CreateResourceBody
  ): Promise<AgentResource> {
    const res = await this.client.post<ResourceResponse>(
      `/agents/${agentId}/resources`,
      body
    );
    return res.data;
  }

  async updateResource(
    agentId: string,
    resourceId: string,
    body: UpdateResourceBody
  ): Promise<AgentResource> {
    const res = await this.client.put<ResourceResponse>(
      `/agents/${agentId}/resources/${resourceId}`,
      body
    );
    return res.data;
  }

  async deleteResource(
    agentId: string,
    resourceId: string
  ): Promise<DeleteResourceResponse> {
    return this.client.delete<DeleteResourceResponse>(
      `/agents/${agentId}/resources/${resourceId}`
    );
  }

  async getLegacyAgents(): Promise<LegacyAgent[]> {
    const res = await this.client.get<{ data: LegacyAgent[] }>(
      "/agents/legacy"
    );
    return res.data;
  }

  async migrateAgent(acpAgentId: number): Promise<Agent> {
    const res = await this.client.post<{ message: string; data: Agent }>(
      "/agents/migrate",
      { acpAgentId }
    );
    return res.data;
  }

  async tokenize(
    agentId: string,
    chainId: number,
    symbol: string,
    txHash?: string
  ): Promise<TokenizeResponse> {
    const payload: Record<string, unknown> = {
      chainId,
      symbol,
      txHash,
    };

    const partnerId = process.env.PARTNER_ID;
    if (partnerId) payload.partnerId = partnerId;

    const res = await this.client.post<{ data: TokenizeResponse }>(
      `/agents/${agentId}/tokenize`,
      payload
    );
    return res.data;
  }
}
