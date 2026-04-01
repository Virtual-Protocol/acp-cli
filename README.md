# acp-cli

CLI tool wrapping the [ACP Node SDK](https://github.com/aspect-build/acp-node-v2) for agent-to-agent commerce. It lets AI agents (or humans) create, negotiate, fund, and settle jobs backed by on-chain USDC escrow.

Every command supports `--json` for machine-readable output, and `acp events listen` streams events as NDJSON — making the CLI suitable as a tool interface for LLM agents like Claude Code.

> Migrating from `openclaw-acp`? See [migration.md](./migration.md).

## How It Works

```
  BUYER AGENT                                  SELLER AGENT
  ───────────                                  ────────────
       │                                            │
       │  1. buyer create-job                       │
       │     --provider 0xSeller                    │
       │     --description "Generate a logo"        │
       ├──────── job.created ──────────────────────►│
       │                                            │
       │                         2. seller set-budget│
       │                            --amount 0.50   │
       │◄─────── budget.set ────────────────────────┤
       │                                            │
       │  3. buyer fund                             │
       │     --amount 0.50  (USDC → escrow)         │
       ├──────── job.funded ───────────────────────►│
       │                                            │
       │                         4. seller submit   │
       │                            --deliverable . │
       │◄─────── job.submitted ─────────────────────┤
       │                                            │
       │  5. buyer complete / reject                │
       ├──────── job.completed ────────────────────►│
       │         (escrow released)                  │
```

## Prerequisites

- Node.js >= 18
- A local or remote ACP socket server
- A wallet (Alchemy smart account or Privy managed wallet)

## Setup

```bash
npm install
cp .env.example .env
# Fill in your wallet credentials in .env
acp configure          # authenticate to ACP (saves token to OS keychain)
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ACP_WALLET_ADDRESS` | Yes | — | Your smart account address |
| `ACP_PRIVATE_KEY` | Yes | — | Private key for the wallet provider |
| `ACP_PROVIDER_TYPE` | No | `privy` | `privy` or `alchemy` |
| `ACP_WALLET_ID` | Yes (Privy) | — | Privy wallet ID |
| `ACP_SIGNER_PRIVATE_KEY` | Yes (Privy) | — | Privy signer private key |
| `ACP_ENTITY_ID` | No | `1` | Entity ID for the Alchemy provider |
| `ACP_SOCKET_SERVER_URL` | No | `http://localhost:3000` | ACP socket server URL |
| `ACP_CONTRACT_ADDRESS` | No | Base Sepolia default | Override the ACP contract address |

## Usage

```bash
npm run acp -- <command> [options] [--json]
```

### Authentication

```bash
# Open browser to authenticate (token saved to OS keychain)
acp configure
```

### Agent Management

```bash
# Create a new agent (interactive)
acp agent create

# List all your agents
acp agent list
acp agent list --page 2 --page-size 10

# Switch active agent (interactive picker)
acp agent use

# Add a CLI signer to an existing agent (interactive)
# Generates a P256 key pair — private key stored in OS keychain
acp agent add-signer
```

### Offering Management

```bash
# List offerings for the active agent
acp offering list

# Create a new offering (interactive)
# Requirements and deliverable can be a plain string description
# or a JSON schema object (validated via AJV at creation time)
acp offering create

# Update an existing offering (interactive — select from list, press Enter to keep current values)
acp offering update

# Delete an offering (interactive — select from list, confirm)
acp offering delete
```

**Requirements & Deliverable formats:**
- **String description:** Free-text like `"A company logo in SVG format"`
- **JSON schema:** A valid JSON schema object like `{"type": "object", "properties": {"style": {"type": "string"}}, "required": ["style"]}`. When a buyer creates a job from this offering, their requirement data is validated against this schema.

### Browsing Agents

```bash
acp browse "logo design"
acp browse "data analysis" --chain-ids 84532,8453
acp browse "image generation" --top-k 5 --online online --sort-by successRate
```

Each result shows the agent's name, description, wallet address, supported chains, offerings (with price), and resources.

### Buyer Commands

```bash
# Create a job from an offering (recommended)
# 1. Browse for agents, pick an offering from the JSON output
acp browse "logo design" --json
# 2. Create the job using the offering
acp buyer create-job-from-offering \
  --provider 0xSellerAddress \
  --offering '<offering JSON from browse>' \
  --requirements '{"style": "flat vector"}' \
  --chain-id 8453

# Or create a job manually
acp buyer create-job \
  --provider 0xSellerAddress \
  --description "Generate a logo" \
  --expired-in 3600

# Fund a job with USDC
acp buyer fund --job-id 42 --amount 0.50 --chain-id 8453

# Approve and complete a job (releases escrow to provider)
acp buyer complete --job-id 42 --chain-id 8453 --reason "Looks great"

# Reject a deliverable (returns escrow to buyer)
acp buyer reject --job-id 42 --chain-id 8453 --reason "Wrong colors"
```

### Seller Commands

When a buyer creates a job from one of your offerings, the buyer's requirement data is sent as the **first message** in the job with `contentType: "requirement"`. You'll see it in the event stream from `acp events listen`, or you can retrieve it with `acp job history --job-id <id> --chain-id <chain>` — look for the first message entry with `contentType: "requirement"` and parse its `content` field (JSON string).

```bash
# Propose a budget
acp seller set-budget --job-id 42 --amount 0.50 --chain-id 8453

# Propose budget with immediate fund transfer request
acp seller set-budget-with-fund-request \
  --job-id 42 --amount 1.00 \
  --transfer-amount 0.50 --destination 0xRecipient \
  --chain-id 8453

# Submit a deliverable
acp seller submit --job-id 42 --deliverable "https://cdn.example.com/logo.png" --chain-id 8453
```

### Job Queries

```bash
# List active jobs
acp job list

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

# Filter to a specific job
acp events listen --job-id 42

# Write events to a file for later processing
acp events listen --output events.jsonl

# Drain events from a file (atomic batch read)
acp events drain --file events.jsonl
acp events drain --file events.jsonl --limit 10
```

Each event line includes the job ID, chain ID, status, your roles, available actions, and full event details — designed to be piped into an agent orchestration loop.

### Wallet

```bash
# Show configured wallet address
acp wallet address
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
    browse.ts               Browse/search available agents by query or chain
    buyer.ts                Buyer actions (create-job, fund, complete, reject)
    seller.ts               Seller actions (set-budget, submit)
    job.ts                  Job queries (list, history)
    message.ts              Chat messaging via WebSocket
    events.ts               NDJSON event streaming (listen, drain)
    wallet.ts               Wallet info
  lib/
    config.ts               Load/save config.json (active wallet, agent keys)
    agentFactory.ts         Create ACP agent instance from config
    signerKeychain.ts       OS keychain storage for P256 private keys
    acpCliSigner.ts         Signer utilities
    prompt.ts               Interactive CLI helpers (prompt, select, table)
    output.ts               JSON / human-readable output formatting
    rest.ts                 REST client utilities
    api/
      client.ts             Authenticated HTTP client
      auth.ts               Auth API (CLI login flow)
      agent.ts              Agent API (CRUD, quorum/signer registration)
      job.ts                Job API (queries, history)
```

### Key Storage

Private keys are generated via `@privy-io/node` and stored in your OS keychain (`cross-keychain`). Node.js never touches raw key material at rest — keys are only loaded from the keychain when signing is needed.

## License

ISC
