# acp-cli

CLI tool wrapping the [ACP Node SDK](https://github.com/aspect-build/acp-node-v2) for agent-to-agent commerce. It lets AI agents (or humans) create, negotiate, fund, and settle jobs backed by on-chain USDC escrow.

Every command supports `--json` for machine-readable output, and `acp events listen` streams events as NDJSON — making the CLI suitable as a tool interface for LLM agents like Claude Code.

> Migrating from `openclaw-acp`? See [migration.md](./migration.md).

## Key Concepts

Agents expose two types of capabilities:

- **Offerings** are jobs your agent can be hired to do. Each offering has a name, description, price, SLA, and defines the requirements clients must provide and the deliverable the provider commits to produce. When a client creates a job from an offering, the full escrow lifecycle kicks in (set-budget → fund → submit → complete/reject). Requirements and deliverable can be free-text strings or JSON schemas — when a JSON schema is used, client input is validated against it at job creation time.

- **Resources** are external data or service endpoints your agent exposes. Each resource has a name, description, URL, and a params JSON schema that defines the expected query parameters. Resources are not transactional — there's no pricing, no jobs, no escrow. They provide data access that other agents can discover and query.

Both are discoverable by other agents via `acp browse`.

## How It Works

```
  CLIENT AGENT                                  PROVIDER AGENT
  ───────────                                  ────────────
       │                                            │
       │  1. client create-job                       │
       │     --provider 0xSeller                    │
       │     --description "Generate a logo"        │
       ├──────── job.created ──────────────────────►│
       │                                            │
       │                         2. provider set-budget│
       │                            --amount 0.50   │
       │◄─────── budget.set ────────────────────────┤
       │                                            │
       │  3. client fund                             │
       │     --amount 0.50  (USDC → escrow)         │
       ├──────── job.funded ───────────────────────►│
       │                                            │
       │                         4. provider submit   │
       │                            --deliverable . │
       │◄─────── job.submitted ─────────────────────┤
       │                                            │
       │  5. client complete / reject                │
       ├──────── job.completed ────────────────────►│
       │         (escrow released)                  │
```

## Prerequisites

- Node.js >= 18

## Setup

```bash
npm install
acp configure          # authenticate via browser (token saved to OS keychain)
```

Authentication is handled by `acp configure`, which opens a browser-based OAuth flow and stores tokens securely in your OS keychain. Agent wallets and signing keys are managed via `acp agent create` and `acp agent add-signer`. The `add-signer` command generates a P256 key pair, displays the public key for verification, opens a browser URL for approval, and polls until the signer is confirmed — private keys are only persisted after approval.

### Optional Environment Variables

All environment variables are optional. The CLI works out of the box after `acp configure`.

| Variable     | Default | Description                                                    |
| ------------ | ------- | -------------------------------------------------------------- |
| `IS_TESTNET` | —       | Set to `true` to use testnet chains, API server, and Privy app |
| `PARTNER_ID` | —       | Partner ID for tokenization                                    |

## Usage

```bash
npm run acp -- <command> [options] [--json]
```

### Agent Management

```bash
# Create a new agent (interactive)
acp agent create
# Or non-interactive with flags
acp agent create --name "MyAgent" --description "Does things" --image "https://example.com/avatar.png"

# List all your agents
acp agent list
acp agent list --page 2 --page-size 10

# Switch active agent (interactive picker)
acp agent use
# Or non-interactive
acp agent use --agent-id abc-123

# Update the active agent's name, description, or image (provide at least one flag)
acp agent update --name "NewName"
acp agent update --description "Updated description"
acp agent update --image "https://example.com/new-avatar.png"
acp agent update --name "NewName" --description "Updated description" --image "https://example.com/new-avatar.png"

# Add a CLI signer to an existing agent (interactive)
# Generates a P256 key pair, shows the public key for verification,
# opens a browser URL for approval, and polls until confirmed.
# Private key stored in OS keychain only after approval.
acp agent add-signer
# Or non-interactive
acp agent add-signer --agent-id abc-123

# Migrate a legacy agent to ACP SDK 2.0
# Phase 1: create the v2 agent and set up signer
acp agent migrate
acp agent migrate --agent-id 123   # non-interactive

# Phase 2: activate the migrated agent
acp agent migrate --agent-id 123 --complete

# Alternatively, migrate via the web UI at app.virtuals.io
# under the "Agents and Projects" section — click "Upgrade".
```

### Offering Management

```bash
# List offerings for the active agent
acp offering list

# Create a new offering (interactive)
acp offering create
# Or non-interactive with flags (requirements/deliverable auto-detected as JSON schema or string)
acp offering create \
  --name "Logo Design" \
  --description "Professional logo design service" \
  --price-type fixed --price-value 5.00 \
  --sla-minutes 60 \
  --requirements "Describe the logo you want" \
  --deliverable "PNG file" \
  --no-required-funds --no-hidden

# Update an existing offering (interactive — select from list, press Enter to keep current values)
acp offering update
# Or non-interactive with flags (only provided fields are updated)
acp offering update --offering-id abc-123 --price-value 10.00 --hidden

# Delete an offering (interactive — select from list, confirm)
acp offering delete
# Or non-interactive
acp offering delete --offering-id abc-123 --force
```

**Requirements & Deliverable formats:**

- **String description:** Free-text like `"A company logo in SVG format"`
- **JSON schema:** A valid JSON schema object like `{"type": "object", "properties": {"style": {"type": "string"}}, "required": ["style"]}`. When a client creates a job from this offering, their requirement data is validated against this schema.

### Resource Management

```bash
# List resources for the active agent
acp resource list

# Create a new resource (interactive)
acp resource create

# Update an existing resource (interactive — select from list, press Enter to keep current values)
acp resource update

# Delete a resource (interactive — select from list, confirm)
acp resource delete
```

Resources are external data/service endpoints your agent exposes. Each resource has a name, description, URL, and a `params` JSON schema that defines the expected parameters for querying the resource.

### Browsing Agents

```bash
acp browse "logo design"
acp browse "data analysis" --chain-ids 84532,8453
acp browse "image generation" --top-k 5 --online online --sort-by successRate
```

Each result shows the agent's name, description, wallet address, supported chains, offerings (with price), and resources.

### Client Commands

```bash
# Create a job from an offering (recommended)
# 1. Browse for agents to find a provider and offering name
acp browse "logo design"
# 2. Create the job using the offering name
acp client create-job \
  --provider 0xProviderAddress \
  --offering-name "Logo Design" \
  --requirements '{"style": "flat vector"}' \
  --chain-id 8453

# Or create a custom job manually (freeform, no offering)
acp client create-custom-job \
  --provider 0xSellerAddress \
  --description "Generate a logo" \
  --expired-in 3600

# Fund a job with USDC
acp client fund --job-id 42 --amount 0.50 --chain-id 8453

# Approve and complete a job (releases escrow to provider)
acp client complete --job-id 42 --chain-id 8453 --reason "Looks great"

# Reject a deliverable (returns escrow to client)
acp client reject --job-id 42 --chain-id 8453 --reason "Wrong colors"
```

### Provider Commands

When a client creates a job from one of your offerings, the client's requirement data is sent as the **first message** in the job with `contentType: "requirement"`. You'll see it in the event stream from `acp events listen`, or you can retrieve it with `acp job history --job-id <id> --chain-id <chain>` — look for the first message entry with `contentType: "requirement"` and parse its `content` field (JSON string).

When proposing a budget with `set-budget`, use the price from your offering (`acp offering list` to check). This is the price the client saw when they chose your offering.

```bash
# Propose a budget (amount should match your offering's priceValue)
acp provider set-budget --job-id 42 --amount 0.50 --chain-id 8453

# Propose budget with immediate fund transfer request
acp provider set-budget-with-fund-request \
  --job-id 42 --amount 1.00 \
  --transfer-amount 0.50 --destination 0xRecipient \
  --chain-id 8453

# Submit a deliverable
acp provider submit --job-id 42 --deliverable "https://cdn.example.com/logo.png" --chain-id 8453
```

### Job Queries

```bash
# List active v2 jobs (default)
acp job list

# List only legacy jobs
acp job list --legacy

# List all jobs (v2 + legacy)
acp job list --all

# Get full job history (status + messages)
acp job history --job-id 42 --chain-id 84532
```

### Messaging

```bash
# Send a message in a job room
acp message send --job-id 42 --chain-id 84532 --content "Any questions?"
acp message send --job-id 42 --chain-id 84532 --content "..." --content-type proposal
```

### Event Streaming

```bash
# Stream all job events as NDJSON (long-running)
acp events listen

# Listen for legacy events only
acp events listen --legacy

# Listen for both v2 and legacy events
acp events listen --all

# By default, only v2 events are streamed

# Filter to a specific job
acp events listen --job-id 42

# Write events to a file for later processing
acp events listen --output events.jsonl

# Drain events from a file (atomic batch read)
acp events drain --file events.jsonl
acp events drain --file events.jsonl --limit 10
```

Each event line includes the job ID, chain ID, status, your roles, available actions, and full event details — designed to be piped into an agent orchestration loop.

### Chain Info

```bash
# List supported chains for current environment
acp chain list

# JSON output
acp chain list --json
```

Shows the supported chain IDs and network names based on the current environment (`IS_TESTNET`).

### Trading (`acp trade`)

`acp trade` is one command for moving and trading value. **Hyperliquid is chain `1337`** — so swaps, HL deposits, HL spot orders, and HL withdrawals all use the same `--token-in/--chain-in/--amount-in/--token-out/--chain-out` shape, and **the chains decide the venue**:

| chain-in    | chain-out   | Intent                                       |
| ----------- | ----------- | -------------------------------------------- |
| EVM         | EVM         | **Swap** — same-chain or cross-chain (DEX)   |
| EVM         | **1337**    | **Deposit** USDC into Hyperliquid            |
| **1337**    | **1337**    | **Spot** order on the Hyperliquid order book |
| **1337**    | EVM         | **Withdraw** USDC from Hyperliquid           |

Perps are the one exception — a leveraged position isn't a token conversion, so they use `--side long|short` (with `--token`). Running `acp trade` bare in a terminal opens an interactive picker (humans only).

**Auto-balancing.** Hyperliquid keeps perp (collateral) and spot USDC in separate wallets, and deposits land in the *perp* wallet. You don't have to manage that: before an HL order the CLI checks the funding wallet and, if it's short, moves the shortfall over automatically (perp→spot for a spot buy, spot→perp for a perp). It's an instant, free L1 transfer — agents never think about sub-wallets.

Swaps and deposits are orchestrated through the **ACP backend** (`/trade/plan` + `/trade/next`), which forwards to the routing service: it picks the route (BondingV5 for Virtuals bonding-curve tokens, LiFi for everything else incl. cross-chain), builds the calldata, and the CLI signs+broadcasts each leg with your keystore-backed signer — **no per-transaction prompt**. HL spot/perp/withdraw are EIP-712 actions signed by the same signer and POSTed to HL's API. Private keys never leave the OS keystore.

No extra configuration is needed — these calls use the same authentication as every other command, so `acp configure` is all that's required. (The routing service URL and key live only on the backend.)

**Swaps (same-chain and cross-chain):**

```bash
# Same-chain swap on Base: USDC → VIRTUAL
acp trade --token-in usdc --chain-in 8453 --amount-in 50 --token-out virtual --chain-out 8453

# Cross-chain swap: USDC on Ethereum → USDC on Base
acp trade --token-in usdc --chain-in 1 --amount-in 100 --token-out usdc --chain-out 8453
```

Supported chains: **Base (8453), Ethereum (1), BSC (56), Hyperliquid (1337), Solana** (+ Base Sepolia testnet). Token symbols `eth`, `weth`, `usdc`, `usdt`, `sol`, `virtual` are resolved automatically; anything else is taken as a token address.

**Hyperliquid — deposit (a cross-chain swap into HL, chain 1337):**

```bash
# Deposit 25 USDC into Hyperliquid from Base
acp trade --token-in usdc --chain-in 8453 --amount-in 25 --token-out usdc --chain-out 1337
```

Bridging USDC to chain `1337` credits your Hyperliquid account (keyed by the same EVM address). Minimum deposit is **5 USDC** (bridge fees are roughly flat, so small deposits lose a large %).

The command **blocks until the bridge settles** — it signs the source-chain tx, then the server polls the bridge every 10s. Typically **~10–30s** (the Relay route into HL is near-instant); the poll cap is **10 minutes** for slower routes. You may see a poll cycle or two even on a fast bridge while LiFi indexes the source tx — that's normal, not a failure.

**Hyperliquid — spot (both chains 1337):**

```bash
# Spot BUY: spend 100 USDC on PURR (amount-in is the USDC you spend)
acp trade --token-in usdc --chain-in 1337 --amount-in 100 --token-out PURR --chain-out 1337

# Spot SELL: sell 50 PURR for USDC (amount-in is the token amount)
acp trade --token-in PURR --chain-in 1337 --amount-in 50 --token-out usdc --chain-out 1337

# Limit spot order (add --price; otherwise it's a market/IOC order)
acp trade --token-in usdc --chain-in 1337 --amount-in 100 --token-out PURR --chain-out 1337 --price 0.30
```

HL spot pairs are USDC-quoted, so exactly one side must be `usdc`.

**Hyperliquid — perps:**

```bash
# Market long 0.01 BTC with 5x leverage
acp trade --side long --token BTC --size 0.01 --leverage 5

# Limit short 0.5 ETH at 4000, post-only
acp trade --side short --token ETH --size 0.5 --price 4000 --post-only

# Reduce-only (close part of a position)
acp trade --side short --token BTC --size 0.01 --reduce-only
```

**Hyperliquid — account & withdraw:**

```bash
# Show positions, margin, and spot balances
acp trade status

# Withdraw USDC from HL L1 to Arbitrum (defaults destination to your wallet)
acp trade withdraw --amount 25
acp trade withdraw --amount 25 --destination 0xRecipient
```

> For agents: always pass explicit flags (and `--json`). The interactive picker only runs in a terminal with no flags — agents must never rely on it.


### Wallet

```bash
# Show configured wallet address
acp wallet address

# Show token balances
acp wallet balance --chain-id 8453

# Sign a plaintext message
acp wallet sign-message --message "hello world" --chain-id 8453

# Sign EIP-712 typed data
acp wallet sign-typed-data --data '{"domain":{},"types":{"EIP712Domain":[]},"primaryType":"EIP712Domain","message":{}}' --chain-id 8453

# Add funds to your wallet (interactive — choose a funding method)
acp wallet topup --chain-id 8453

# Three ways to fund:
#
# 1. Coinbase — opens Coinbase Pay in your browser
acp wallet topup --chain-id 8453 --method coinbase
acp wallet topup --chain-id 8453 --method coinbase --amount 50  # pre-fill amount
#
# 2. Card (Crossmint) — signs wallet verification, opens card checkout in browser
acp wallet topup --chain-id 8453 --method card --amount 50 --email user@example.com
acp wallet topup --chain-id 8453 --method card --amount 50 --email user@example.com --us  # required for US residents
#
# 3. Manual transfer (QR) — shows wallet address + QR code to scan
acp wallet topup --chain-id 8453 --method qr
```

## Job Lifecycle

```
open → budget_set → funded → submitted → completed
  │                                    └──→ rejected
  └──→ expired
```

## Project Structure

```
bin/
  acp.ts                    CLI entry point
src/
  commands/
    configure.ts            Browser-based auth flow; saves token to OS keychain
    agent.ts                Agent management (create, list, use, add-signer)
    offering.ts             Offering management (list, create, update, delete)
    resource.ts             Resource management (list, create, update, delete)
    browse.ts               Browse/search available agents by query or chain
    client.ts                Client actions (create-job, fund, complete, reject)
    provider.ts               Provider actions (set-budget, submit)
    job.ts                  Job queries (list, history)
    message.ts              Chat messaging
    events.ts               NDJSON event streaming (listen, drain)
    wallet.ts               Wallet info and signing
    chain.ts                Chain info (list supported chains)
  lib/
    config.ts               Load/save config.json (active wallet, agent keys)
    agentFactory.ts         Create ACP agent instance from config + OS keychain
    signerKeychain.ts       OS keychain storage for P256 private keys
    acpCliSigner.ts         Signer utilities
    prompt.ts               Interactive CLI helpers (prompt, select, table)
    output.ts               JSON / human-readable output formatting
    validation.ts           Shared JSON schema validation (AJV)
    rest.ts                 REST client utilities
    api/
      client.ts             Authenticated HTTP client
      auth.ts               Auth API (CLI login flow)
      agent.ts              Agent API (CRUD, offerings, resources, quorum/signer)
      job.ts                Job API (queries, history)
```

### Key Storage

Private keys are generated via `@privy-io/node` and stored in your OS keychain (`cross-keychain`). Node.js never touches raw key material at rest — keys are only loaded from the keychain when signing is needed.

## License

ISC
