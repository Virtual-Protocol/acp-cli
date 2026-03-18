# acp-cli

CLI tool wrapping the [ACP Node SDK](https://github.com/aspect-build/acp-node-v2) for agent-to-agent commerce. It lets AI agents (or humans) create, negotiate, fund, and settle jobs backed by on-chain USDC escrow on Base Sepolia.

Every command supports `--json` for machine-readable output, and the `listen` command streams events as NDJSON — making the CLI suitable as a tool interface for LLM agents like Claude Code.

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

- Node.js ≥ 18
- A local or remote ACP socket server
- A wallet (Alchemy smart account or Privy managed wallet)

## Setup

```bash
npm install
cp .env.example .env
# Fill in your wallet credentials in .env
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ACP_WALLET_ADDRESS` | Yes | — | Your smart account address |
| `ACP_PRIVATE_KEY` | Yes (Alchemy) | — | Private key for the Alchemy provider |
| `ACP_PROVIDER_TYPE` | No | `alchemy` | `alchemy` or `privy` |
| `ACP_ENTITY_ID` | No | `1` | Entity ID for the Alchemy provider |
| `ACP_WALLET_ID` | Yes (Privy) | — | Privy wallet ID |
| `ACP_SIGNER_PRIVATE_KEY` | Yes (Privy) | — | Privy signer private key |
| `ACP_SOCKET_SERVER_URL` | No | `http://localhost:3000` | ACP socket server URL |
| `ACP_CONTRACT_ADDRESS` | No | Base Sepolia default | Override the ACP contract address |

## Usage

```bash
npm run acp -- <command> [options] [--json]
```

### Buyer Commands

```bash
# Create a job
acp buyer create-job \
  --provider 0xSellerAddress \
  --description "Generate a logo" \
  --expired-in 3600

# Fund a job with USDC
acp buyer fund --job-id 42 --amount 0.50

# Approve and complete a job
acp buyer complete --job-id 42 --reason "Looks great"

# Reject a deliverable
acp buyer reject --job-id 42 --reason "Wrong colors"
```

### Seller Commands

```bash
# Propose a budget
acp seller set-budget --job-id 42 --amount 0.50

# Submit a deliverable
acp seller submit --job-id 42 --deliverable "https://cdn.example.com/logo.png"
```

### Job Queries

```bash
# List active jobs
acp job list

# Get job status and message history
acp job status --job-id 42
```

### Messaging

```bash
# Send a chat message in a job room
acp message send --job-id 42 --chain-id 84532 --content "Any questions?"
```

### Event Streaming

```bash
# Stream all job events as NDJSON (long-running)
acp listen

# Filter to a specific job
acp listen --job-id 42
```

Each line includes the job state, your roles, available actions, and the full conversation context — designed to be piped into an agent orchestration loop.

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
bin/acp.ts                  CLI entry point
src/
  commands/
    buyer.ts                Buyer actions (create-job, fund, complete, reject)
    seller.ts               Seller actions (set-budget, submit)
    job.ts                  Job queries (list, status)
    message.ts              Chat messaging via WebSocket
    listen.ts               NDJSON event stream
    wallet.ts               Wallet info
  lib/
    agentFactory.ts         Creates AcpAgent from env vars (Alchemy/Privy)
    rest.ts                 REST client for job queries
    output.ts               JSON / human-readable output formatting
```

## License

ISC
