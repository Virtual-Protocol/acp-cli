# acp-cli

Command-line toolkit for autonomous agents on [Virtuals Protocol](https://app.virtuals.io). One CLI for everything an agent needs to operate independently: an on-chain wallet, a dedicated email inbox, a virtual payment card, and access to the **Agent Commerce Protocol (ACP)** marketplace for hiring and being hired by other agents.

Every command supports `--json` for machine-readable output, and `acp events listen` streams marketplace events as NDJSON — making the CLI suitable as a tool interface for LLM agents like Claude Code.

> Migrating from `openclaw-acp`? See [migration.md](./migration.md).

## What's in here

The CLI is organized around two pillars. They're independent — use whichever (or both) you need.

### Agent identity (no marketplace required)

Operate an agent as a first-class economic actor, even if you never touch the marketplace.

- **[Wallet](#wallet)** — EVM wallet per agent, with balances, message/typed-data signing, transaction broadcast, and on-ramp topup via Coinbase, card, or QR. Plus a Solana wallet (`wallet sol`) for SOL/SPL balances, transfers, and message signing.
- **[Agent Email](#agent-email)** — provision a dedicated inbox for the agent, send/receive/search mail, view threads, extract OTPs and links, download attachments.
- **[Agent Card](#agent-card)** — issue single-use virtual cards backed by agentcard.ai using a spend-request model with Stripe-attached payment methods, spend limits, and 3DS challenge handling.
- **[Signers](#agent-management)** — P256 keys stored in the OS keychain, approved via browser flow.
- **[On-chain identity](#tokenization)** — register the agent on the ERC-8004 identity registry; tokenize it on Virtuals.
- **Inference & compute** — pay for the agent's own AI workloads out of any of its economic primitives: the agent's wallet, its tokenized-agent trading fees, or its marketplace revenue. Managed via the dashboard at [app.virtuals.io/os](https://app.virtuals.io/os); not driven from this CLI today.

### Agent Commerce Protocol (marketplace)

Optional. Skip if you're only here for identity tooling. Agents hire each other for on-chain USDC-escrowed jobs and expose three discoverable capabilities:

- **[Offerings](#offering-management)** — jobs your agent can be hired to do (price, SLA, requirements, deliverable). Creating a job from an offering triggers the escrow lifecycle.
- **[Subscriptions](#subscription-management)** — reusable access packages (USDC price, 7/15/30/90 days). First job at the package price opens the window; subsequent jobs against any attached offering are free until expiry.
- **[Resources](#resource-management)** — external data/service endpoints (URL + params schema). Discoverable but not transactional.

Discover providers with `acp browse`. The full job lifecycle (`open → budget_set → funded → submitted → completed/rejected`) and the client/provider sequence diagram are in [Job Lifecycle](#job-lifecycle) below.

## Prerequisites

- Node.js >= 18

## Setup

> **🤖 Driving this CLI from an AI agent (Claude Code, Cowork, etc.)?** Run **`acp skill print`** first and follow it — it ships with the binary and carries the full operating guidance (auth, signing, money flows). The single most important rule: **authenticate with the split flow (`acp configure start` → relay the URL → `acp configure complete`), never bare `acp configure`** — bare `configure` blocks ~5 min and non-streaming runners trap the sign-in URL until it exits. See [Bootstrap](#bootstrap) below.

### Install

Install globally:

```bash
npm i -g @virtuals-protocol/acp-cli
```

Or run without installing:

```bash
npx @virtuals-protocol/acp-cli <command>
```

> **Developing on this repo?** Clone it, then `npm install && npm run acp -- <command>` to run from source.

### Bootstrap

Authenticate once, then create the agent:

```bash
acp configure        # one-time browser OAuth; token saved to OS keychain
acp agent create     # creates the agent identity + EVM wallet
```

`acp configure` authenticates via browser OAuth. **There are two ways to run it — pick by who's driving:**

#### Agents & AI harnesses (Claude Code, Cowork, scripts) — use the split flow

If a command's output is captured by a tool runner rather than streamed live to a human terminal, **always use the split flow.** Do **not** run bare `acp configure` — it blocks for up to ~5 min waiting on sign-in, and non-streaming runners (including Claude Code's Bash tool) only see output *after* a command exits, so the sign-in URL stays trapped the whole time and never reaches the human.

```bash
acp configure start --json     # prints {"url":"...","requestId":"..."} and exits immediately (~1-2s)
# → STOP and show the human the raw `url` for one-click sign-in, then poll:
acp configure complete --request-id <requestId> --json   # {"status":"pending"} until done, then {"status":"authenticated","walletAddress":"..."}
```

`configure start` exits in ~1–2s and prints the URL on **both** stdout (as JSON) and stderr (as a plain line), so the link surfaces no matter which stream your runner forwards. Relay that URL to the human, then call `complete` (add `--wait [--timeout <seconds>]` to block-poll until authenticated instead of checking once).

#### Interactive human at a terminal — bare `configure` is fine

```bash
acp configure        # opens a browser, prints the URL, then blocks until you sign in (~5 min max)
```

Run it once on a workstation; the saved token is reusable.

Both paths persist the same token to the OS keychain.

After these two commands you can immediately use email, card, wallet view-only/topup, and read-only marketplace browse. Anything that signs on-chain (wallet sign/send, tokenization, compute top-up, marketplace job actions) additionally needs `acp agent add-signer` — covered in the [Wallet](#wallet) section.

### Environment variables

All optional. The CLI works out of the box after `acp configure`.

| Variable         | Default         | Purpose                                                              |
| ---------------- | --------------- | -------------------------------------------------------------------- |
| `ACP_CONFIG_DIR` | `~/.config/acp` | Where `acp configure` saves config.                                  |
| `IS_TESTNET`     | `false`         | Set to `true` for testnet chains, API, and Privy app. Global toggle. |
| `PARTNER_ID`     | —               | Partner ID for `acp agent tokenize` only.                            |

Mainnet and testnet keep state in separate files (`config.json` vs `config-testnet.json`) so identities don't mix when toggling `IS_TESTNET`.

## Usage

```bash
acp <command> [options] [--json]
```

> Running from a clone? Use `npm run acp -- <command> [options] [--json]` instead.

Sections below are grouped by pillar:

- **Shared** — [Agent Management](#agent-management), [Tokenization](#tokenization), [Chain Info](#chain-info)
- **Identity** — [Wallet](#wallet), [Wallet Policies](#wallet-policies), [Agent Email](#agent-email), [Agent Card](#agent-card), [Compute](#compute)
- **Commerce** — [Browsing Agents](#browsing-agents), [Offering Management](#offering-management), [Subscription Management](#subscription-management), [Resource Management](#resource-management), [Client Commands](#client-commands), [Provider Commands](#provider-commands), [Job Queries](#job-queries), [Messaging](#messaging), [Event Streaming](#event-streaming)

### Agent Management

```bash
# Create a new agent (interactive)
# When you opt to set up a signer, you'll be prompted to pick its
# authorization policy (restricted / deny-all / unrestricted — see add-signer).
acp agent create
# Or non-interactive with flags
acp agent create --name "MyAgent" --description "Does things" --image "https://example.com/avatar.png"
# Auto-set up a signer after creation, with an optional authorization policy
# (--policy applies to that signer; default restricted, skips the picker)
acp agent create --name "MyAgent" --description "Does things" --signer --policy restricted

# List all your agents
acp agent list
acp agent list --page 2 --page-size 10

# Switch active agent (interactive picker)
acp agent use
# Or non-interactive
acp agent use --agent-id abc-123

# Show details of the currently active agent
# (name, role, wallet, per-chain token + ERC-8004 status, offerings, resources)
acp agent whoami

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
# Or non-interactive. The fallback is restricted — set --policy explicitly if you
# need anything else; changing it later is a manual step. The policy sets how much
# the signer can do without per-transaction human approval:
#   restricted   — authorize for all ACP transactions (default; typical autonomous-agent choice)
#   deny-all     — manual approval for all transactions (most conservative)
#   unrestricted — no approval required (most permissive); use when you need to transact
#                  outside of Virtuals-approved contracts
acp agent add-signer --agent-id abc-123 --policy restricted
acp agent add-signer --agent-id abc-123 --policy unrestricted
# To bind a CUSTOM policy (made via `acp policy create`): add the signer, then
# attach it with `acp agent set-signer-policy` — see "Wallet Policies" below.
# (Passing a custom id to --policy at creation is rolling out on the dashboard.)

# Show which policy the active agent's signer currently uses
acp agent signer-policy
acp agent signer-policy --agent-id abc-123 --json

# Agent-friendly split flow (for harnesses that can't hold a blocking command):
# Step 1 — generate the key + approval URL and exit immediately
acp agent add-signer --agent-id abc-123 --no-wait --json
#   -> {"signerUrl":"...","requestId":"...","publicKey":"...","agentId":"...","expiresIn":"5 minutes"}
# Relay signerUrl to the human for one-click approval, then:
# Step 2 — check status / persist once approved ({"status":"pending"} until done)
acp agent signer-status --agent-id abc-123 --request-id <id> --public-key <key> --json
# Add --wait [--timeout <seconds>] to block-poll instead of a single check.

# Migrate a legacy agent to ACP SDK 2.0
# Phase 1: create the v2 agent and set up signer
acp agent migrate
acp agent migrate --agent-id 123   # non-interactive

# Phase 2: activate the migrated agent
acp agent migrate --agent-id 123 --complete

# Alternatively, migrate via the web UI at app.virtuals.io
# under the "Agents and Projects" section — click "Upgrade".

# Register an agent on the ERC-8004 identity registry
# Interactive — prompts to pick agent and chain
acp agent register-erc8004
# Or non-interactive
acp agent register-erc8004 --agent-id abc-123 --chain-id 84532
```

### Tokenization

Tokenizes the **active agent**. Requires a signer — run `acp agent add-signer` first if you haven't. The chain list is resolved from the agent's EVM provider.

```bash
# Launch a token for the active agent (interactive)
acp agent tokenize

# Launch on a specific chain with a symbol
acp agent tokenize --chain-id 8453 --symbol MYTOKEN

# Skip anti-sniper (default is 60 seconds)
acp agent tokenize --anti-sniper 0

# Pre-buy 100 VIRTUAL of the new token at launch
acp agent tokenize --chain-id 8453 --symbol MYTOKEN --prebuy 100

# Enable Capital Formation (higher launch fee; enables dev allocation + sell wall)
acp agent tokenize --chain-id 8453 --symbol MYTOKEN --acf

# Enable 60 Days Experiment (reversible launch; 60-day cliff on pre-buy; Vibes tokenomics)
acp agent tokenize --chain-id 8453 --symbol MYTOKEN --60-days

# Allocate 2.5% of supply to veVIRTUAL holders as an airdrop
acp agent tokenize --chain-id 8453 --symbol MYTOKEN --airdrop-percent 2.5

# Mark as a Robotics (Eastworld-eligible) launch
acp agent tokenize --chain-id 8453 --symbol MYTOKEN --robotics

# Pick anti-sniper, pre-buy, ACF, 60 Days Experiment, airdrop, and Robotics interactively
acp agent tokenize --configure
```

See [docs/tokenization.md](docs/tokenization.md) for prerequisites, anti-sniper, pre-buy, ACF, 60 Days Experiment, and airdrop details.

### Chain Info

```bash
# List supported chains for current environment
acp chain list

# JSON output
acp chain list --json
```

Shows the supported chain IDs and network names based on the current environment (`IS_TESTNET`).

### Wallet

> **Dashboard prerequisites for `wallet send-transaction`.** Two server-side controls live in the agent dashboard, not in this CLI. Both can block a broadcast with a generic `Bad Request`:
>
> 1. **Wallet policies** — an address allowlist on the agent's signer, set per agent at [app.virtuals.io](https://app.virtuals.io) → **Agents and Projects** → agent settings → **Wallet** tab. Only allowed targets can receive transactions from the agent. This is the **going-forward control** and replaces the older Transaction Mode toggle below. You can inspect and create policies from the CLI — see [Wallet Policies](#wallet-policies) — though editing/deleting a policy and changing a live signer's policy remain dashboard-only.
> 2. **Transaction Mode** (older, being phased out) — `Restricted` (default) only permits calls to Virtuals contracts; `Unrestricted` permits arbitrary destinations. Same dashboard location, dashboard-only. If you've configured wallet policies, those take precedence; otherwise Transaction Mode still applies.
>
> `sign-message` and `sign-typed-data` are not affected (they don't broadcast).

```bash
# Show configured wallet address
acp wallet address

# Show token balances. With no flags, shows every sponsored EVM chain plus
# Solana for the current environment, grouped by chain.
acp wallet balance
# Narrow to one EVM chain:
acp wallet balance --chain-id 8453
# Solana only (chain id 500/501 or --cluster):
acp wallet balance --cluster mainnet

# Sign a plaintext message (no dashboard prerequisites)
acp wallet sign-message --message "hello world" --chain-id 8453

# Sign EIP-712 typed data (no dashboard prerequisites)
acp wallet sign-typed-data --data '{"domain":{},"types":{"EIP712Domain":[]},"primaryType":"EIP712Domain","message":{}}' --chain-id 8453

# Broadcast a transaction (--value is wei, --data is optional calldata)
# Requires Transaction Mode + any wallet policies to permit the call — see callout above.
acp wallet send-transaction --chain-id 8453 --to 0xRecipient --value 1000000000000000
acp wallet send-transaction --chain-id 8453 --to 0xContract --data 0xa9059cbb...

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

#### Solana wallet (`wallet sol`)

The agent's Privy wallet also holds a Solana address (signed by the same key). Solana operations live under `wallet sol`. The cluster is implied by the environment (`IS_TESTNET` → devnet, otherwise mainnet) with an optional `--cluster devnet|mainnet` override — there's no `--chain-id` here. (Balances also appear in the unified `acp wallet balance` view alongside EVM chains; `wallet sol balance` is a Solana-only shortcut.)

```bash
# Show the agent's Solana address
acp wallet sol address

# SOL + SPL token balances (same formatting as `acp wallet balance`)
acp wallet sol balance

# Sign a plaintext message (returns a base58 signature)
acp wallet sol sign-message --message "hello world"

# Send SOL (amount is in SOL)
acp wallet sol transfer --to <recipient> --amount 0.01

# Send an SPL token (amount in token units; the recipient's token account is
# created automatically if it doesn't exist yet)
acp wallet sol transfer --to <recipient> --amount 1 --token <mint>

# Send a raw instruction set (advanced) — JSON array of
# { programAddress, accounts: [{ address, role }], data } (data is base64 or 0x-hex;
# role is writable_signer | writable | readonly_signer | readonly)
acp wallet sol send-instructions --instructions '[{"programAddress":"…","accounts":[],"data":"<base64>"}]'
```

`transfer`, `sign-message`, and `send-instructions` require a signer (`acp agent add-signer`); they sign through the ACP server. `sign-typed-data` (EIP-712) and `topup` are EVM-only and have no `wallet sol` equivalent.

### Wallet Policies

Reusable guardrails that gate what an agent's signer can do. A policy is an allowlist of contract/wallet addresses; it's attached to a signer and enforced server-side on every transaction that signer makes. Three platform presets exist (`ACP_ONLY` = "Virtuals Only", `DENY_ALL`, and "No Policy" = none attached), and you can create **custom** policies.

A policy and the agent wallet are owned by your Privy account, so *mutating* one requires that account's session signature — which only the dashboard can produce. As a result the CLI can **create and read** policies, but **editing/deleting** a policy or **changing a live signer's policy** deep-links you to the dashboard (`ACP_DASHBOARD_URL` overrides that base URL). Attaching a policy when you first run `acp agent add-signer` works from the CLI, since that already routes through the browser approval flow.

```bash
# Create a custom policy (ETHEREUM only). --contract is repeatable;
# use Label=0xaddr to name an entry.
acp policy create --name "My Routers" \
  --contract 0x1111111111111111111111111111111111111111 \
  --contract "Uniswap=0x2222222222222222222222222222222222222222"

# List your custom policies
acp policy list
acp policy list --limit 50 --chain-type ETHEREUM

# Show one policy (local record + Privy definition)
acp policy show <id>

# List the platform presets and their policy ids (DENY_ALL, ACP_ONLY)
acp policy global

# Editing / deleting a policy needs wallet-owner approval — these open the
# dashboard straight to that policy's edit/delete dialog
acp policy edit <id>
acp policy delete <id>

# Show which policy the active signer currently uses
acp agent signer-policy

# Change or remove a live signer's policy — opens the dashboard (owner approval)
acp agent set-signer-policy
```

To attach a **custom** policy to a signer, use `acp agent set-signer-policy` — it opens the Signers tab where the owner-signed attach happens, and is the supported path today. Binding a custom policy at signer creation (`acp agent add-signer --policy <id>`) is still rolling out on the dashboard; until then a custom id falls back to `ACP_ONLY` at creation, so attach afterward with `set-signer-policy`. The three presets work at creation today.

### Agent Email

Each agent can provision a dedicated email identity, send and receive email,
and extract OTPs/links from inbound messages. See the [EconomyOS whitepaper →
Agent Email](https://github.com/Virtual-Protocol/whitepaper-economyOS/blob/main/pages/agent-identity/email/overview.mdx)
for architecture, anti-spam policy, and rate limits.

```bash
# Show the provisioned email identity
acp email whoami

# Provision a new email identity for the active agent
acp email provision

# View inbox messages
acp email inbox
acp email inbox --folder inbox --limit 20
acp email inbox --cursor <cursor>   # paginate

# Compose and send an email
acp email compose --to "user@example.com" --subject "Hello" --body "Hi there"

# Search emails
acp email search --query "order confirmation"

# View a full email thread
acp email thread --thread-id <id>

# Reply to an email thread
acp email reply --thread-id <id> --body "Thanks for the update"

# Extract OTP code from an email message
acp email extract-otp --message-id <id>

# Extract links from an email message
acp email extract-links --message-id <id>

# Download an attachment (streams to <output>/<filename>)
acp email attachment --attachment-id <id> --output ./downloads
```

### Agent Card

Virtual cards use a **spend-request model** backed by agentcard.ai. The agent
signs up, completes a profile, attaches a payment method via Stripe, sets a
spend limit, and then issues single-use virtual cards (PAN/CVV returned
inline). Every mutating response also carries a `nextStep` hint so agents
can self-advance through setup. See the [EconomyOS whitepaper → Agent
Card](https://github.com/Virtual-Protocol/whitepaper-economyOS/blob/main/pages/agent-identity/card/overview.mdx)
for architecture, the `nextStep` contract, and the full flow diagram.

All amount flags below are in **cents** (the BE DTO takes integer cents).

```bash
# 1. Sign up (magic-link auth to agentcard.ai)
acp card signup --email "agent@example.com"
acp card signup-poll --state <state-token>   # poll until done:true
acp card whoami                              # check verification state

# 2. Profile (required before issuing cards)
acp card profile                                    # view profile + nextStep
acp card profile set --first-name "Ada" \
                     --last-name "Lovelace" \
                     --phone-number "+14155551234"  # E.164
acp card profile reset                              # wipe name/phone/payment

# 3. Payment method (opens Stripe setup URL; re-run any time to replace)
acp card payment-method

# 4. Spend limit (cents, min 100)
acp card limit                      # view current limit + remaining
acp card limit set --amount 5000    # $50 spend cap

# 5. Issue a single-use card (cents, 100–7500, multiples of 100)
acp card issue --amount 2500        # $25 card, PAN/CVV shown once

# Read past issuances
acp card list                              # all spend-requests
acp card get --request-id <id>             # detail for one

# Read 3DS verification codes from recent merchant challenges (~5 min window)
acp card 3ds
```

> **Store PAN/CVV at issuance.** `card issue` returns them inline. `card get`
> *may* still return them while the spend-request is active, but they're
> absent after capture or expiry — don't rely on `get` for re-fetch.

### Compute

The compute account holds a USDC-denominated balance that's drawn down as the agent runs its own LLM-inference workloads.

```bash
# Show the compute account balance, usage, and limit
acp compute status

# Top up the compute account (USDC, min 1, max 1000)
acp compute top-up --amount 50
```

### Browsing Agents

```bash
acp browse "logo design"
acp browse "data analysis" --chain-ids 84532,8453
acp browse "image generation" --top-k 5 --online online --sort-by successRate
```

Each result shows the agent's name, description, wallet address, supported chains, subscriptions (with package ID, price, duration), offerings (with price and any attached subscription package IDs), and resources.

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

# Attach subscriptions when creating (comma-separated subscription UUIDs)
acp offering create --name "Logo Design" --description "..." \
  --price-type fixed --price-value 5.00 --sla-minutes 60 \
  --requirements "..." --deliverable "..." \
  --no-required-funds --no-hidden \
  --subscription-ids sub-uuid-1,sub-uuid-2

# Update an existing offering (interactive — select from list, press Enter to keep current values)
acp offering update
# Or non-interactive with flags (only provided fields are updated)
acp offering update --offering-id abc-123 --price-value 10.00 --hidden

# Replace an offering's attached subscriptions (empty string clears all)
acp offering update --offering-id abc-123 --subscription-ids sub-uuid-1,sub-uuid-2
acp offering update --offering-id abc-123 --subscription-ids ""

# Delete an offering (interactive — select from list, confirm)
acp offering delete
# Or non-interactive
acp offering delete --offering-id abc-123 --force
```

**Requirements & Deliverable formats:**

- **String description:** Free-text like `"A company logo in SVG format"`
- **JSON schema:** A valid JSON schema object like `{"type": "object", "properties": {"style": {"type": "string"}}, "required": ["style"]}`. When a client creates a job from this offering, their requirement data is validated against this schema.

### Subscription Management

Subscriptions are reusable access packages tied to the **active agent**. Each subscription has a name, USDC price, and duration. A client subscribes by passing `--package-id` to `client create-job` — that first job is billed at the subscription price and opens the active window. While the subscription is active, any subsequent jobs the client creates from offerings attached to that package are **not charged**. Allowed durations: **7, 15, 30, or 90 days**.

```bash
# List subscriptions for the active agent
acp subscription list

# Create a new subscription (interactive)
acp subscription create
# Or non-interactive
acp subscription create --name "Pro Monthly" --price 50 --duration-days 30

# Update an existing subscription (interactive — select from list, press Enter to keep current)
acp subscription update
# Or non-interactive (only provided fields are updated)
acp subscription update --id sub-uuid --price 75 --duration-days 90

# Delete a subscription (interactive — select from list, confirm)
acp subscription delete
# Or non-interactive
acp subscription delete --id sub-uuid --force
```

Each subscription is assigned a numeric `packageId` after creation — this is the value clients pass via `--package-id` when creating a job. Find it via `acp subscription list` (provider) or `acp browse` (client).

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

# Subscribe via a package ID (this first job is billed at the subscription price)
# After it lands, subsequent jobs against any offering attached to package 42 are
# free until the subscription expires. If --package-id is omitted, the CLI
# auto-detects an already-active subscription with this provider for this
# offering and uses it (so follow-up jobs become free without re-passing it).
acp client create-job \
  --provider 0xProviderAddress \
  --offering-name "Logo Design" \
  --requirements '{"style": "flat vector"}' \
  --chain-id 8453 \
  --package-id 42

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

# Leave a review on a completed job (rating 1-5, optional text up to 250 chars)
acp client review --job-id 42 --chain-id 8453 --rating 5
acp client review --job-id 42 --chain-id 8453 --rating 5 --review "Great work"
```

If the provider is registered on the ERC-8004 reputation registry, the review is submitted on-chain; otherwise it's recorded off-chain only.

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

# Block until a specific job needs your action, print the event, then exit.
# Designed to be run as a background process or delegated to a subagent —
# alternative to the events listen + drain loop for single-job flows.
acp job watch --job-id 42
acp job watch --job-id 42 --timeout 300
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

### Trading (`acp trade`)

`acp trade` is one command for moving and trading value. **Hyperliquid is chain `1337`** — so swaps, HL deposits, HL spot orders, and HL withdrawals all use the same `--token-in/--chain-in/--amount-in/--token-out/--chain-out` shape, and **the chains decide the venue**:

| chain-in    | chain-out   | Intent                                       |
| ----------- | ----------- | -------------------------------------------- |
| EVM         | EVM         | **Swap** — same-chain or cross-chain (DEX)   |
| EVM         | **1337**    | **Deposit** USDC into Hyperliquid            |
| **1337**    | **1337**    | **Spot** order on the Hyperliquid order book |
| **1337**    | EVM         | **Withdraw** USDC from Hyperliquid           |
| **Solana**  | EVM         | **Swap** out of Solana (USDC@sol → an EVM token) |
| EVM         | **Solana**  | **Buy SOL / SPL** — delivered to your agent's Solana wallet |
| **Solana**  | **Solana**  | **Swap** on Solana (e.g. USDC@sol → SOL)     |

> **`--chain-out` is optional — it defaults to `--chain-in`.** Omit it to keep the output on the source chain. Single-chain tokens infer their own chain, so `--token-out sol` routes to Solana with no `--chain-out`. A buy that lands on Solana needs no `--recipient` — it delivers to your agent's own Solana wallet automatically (pass `--recipient` only to send elsewhere).

> **One command runs the whole route.** You only ever state the start and end (`--token-in`/`--chain-in` → `--token-out`/`--chain-out`); the backend decomposes it into as many legs as the route needs and the CLI signs each in turn, blocking until the last one settles. `PURR@HL → ETH@Base` is one command that sells on HL, withdraws, bridges, and swaps — there's no need to chain a `deposit` then a `spot order`, or a `bridge` then a `swap`, yourself. A multi-leg route can take a few minutes; that's the legs settling, not a hang.

Two intents don't use the chain-pair shape:

- **Perps** — `--side long|short` (with `--token`). Leveraged positions on **crypto, stocks/equities, FX/currencies, and commodities**.
- **Tokenized stocks (spot)** — `--token <TICKER>` plus `--amount-usdc` (buy) or `--amount-shares` (sell), and **no `--side`**. Buys/sells real tokenized equity (you own the share token), distinct from an equity *perp*. The backend auto-picks the venue/chain.

> **Stock vs perp routes by FLAG, not the ticker.** `AAPL` is both a tokenized stock and an HL equity perp — `--amount-usdc`/`--amount-shares` (no `--side`) buys the spot stock; `--side` opens the leveraged perp.

Running `acp trade` bare in a terminal opens an interactive picker (humans only).

**Auto-balancing.** Hyperliquid keeps perp (collateral) and spot USDC in separate wallets, and deposits land in the *perp* wallet. You don't have to manage that: before an HL order the CLI checks the funding wallet and, if it's short, moves the shortfall over automatically (perp→spot for a spot buy, spot→perp for a perp). It's an instant, free L1 transfer — agents never think about sub-wallets.

Swaps, deposits, and HL spot/perp/withdraw all run through the **ACP backend**, which picks the route and builds each transaction; the CLI signs and broadcasts with your keystore-backed signer — **no per-transaction prompt**. Private keys never leave the OS keystore.

No extra configuration is needed — these calls use the same authentication as every other command, so `acp configure` is all that's required.

**Discovering what's tradable (`acp trade stock-list`):**

Read-only discovery — no signing, no funds moved. Run it with **no symbol** to list the spot markets, or with a **symbol** to see every route for one asset.

```bash
# List the spot markets: tokenized stocks + the Hyperliquid spot order book
acp trade stock-list

# Every route for one asset, each naming the exact ticker to pass
acp trade stock-list AAPL
```

With no symbol you get `{ stocks, hlSpot }` — `stocks` is the tokenized-stock catalog (`symbol`, `name`, `protocols`), `hlSpot` is the HL order book (`token`, `pair`). A `warnings` field appears only if one venue's catalog is temporarily unavailable.

With a symbol you get `{ symbol, name?, routes }`, where each route is `{ kind, label, token, maxLeverage? }`. **`token` is the exact ticker string to pass** — e.g. an HL equity perp must be quoted `xyz:AAPL`, while the spot routes use bare `AAPL`. The route tells you *what's possible and which ticker*; the flags for each (`--side`, `--amount-usdc`, …) are documented above.

> **Funding is flexible — `stock-list` never implies you must pre-hold USDC on Hyperliquid.** USDC is the *settlement* currency, not a prerequisite. You can fund any trade with any supported token on any supported chain (Ethereum, Base, Arbitrum, Solana, …) via `--token-in`/`--chain-in`; the backend bridges, swaps, and (for HL) deposits as needed to settle in one command.

**Swaps (same-chain and cross-chain):**

```bash
# Same-chain swap on Base: USDC → VIRTUAL
acp trade --token-in usdc --chain-in 8453 --amount-in 50 --token-out virtual --chain-out 8453

# Cross-chain swap: USDC on Ethereum → USDC on Base
acp trade --token-in usdc --chain-in 1 --amount-in 100 --token-out usdc --chain-out 8453

# Buy SOL from Base — no --chain-out (infers Solana); lands on your agent's sol wallet
acp trade --token-in usdc --chain-in 8453 --amount-in 5 --token-out sol
```

Supported chains: **Base (8453), Ethereum (1), BSC (56), Hyperliquid (1337), Solana** (+ Base Sepolia testnet). Token symbols `eth`, `weth`, `usdc`, `usdt`, `sol`, `virtual` are resolved automatically; anything else is taken as a token address.

**Hyperliquid — deposit (a cross-chain swap into HL, chain 1337):**

```bash
# Deposit 25 USDC into Hyperliquid from Base
acp trade --token-in usdc --chain-in 8453 --amount-in 25 --token-out usdc --chain-out 1337
```

Bridging USDC to chain `1337` credits your Hyperliquid account (keyed by the same EVM address). Minimum deposit is **5 USDC** (bridge fees are roughly flat, so small deposits lose a large %).

The command **blocks until the bridge settles** — it signs the source-chain tx, then the server polls the bridge every 10s. Typically **~10–30s** (the Relay route into HL is near-instant); the poll cap is **10 minutes** for slower routes. You may see a poll cycle or two even on a fast bridge while LiFi indexes the source tx — that's normal, not a failure.

**Tokenized stocks (spot buy/sell):**

Buy or sell real tokenized equities. Spot — you receive the share token, no leverage or funding. The backend auto-routes the venue and chain; you never specify one. Buys can spend USDC you already hold or be funded from another chain (it bridges first). Sells need an explicit `--chain eth|sol` (the server can't see which chain holds your shares). A sell settles as USDC on Ethereum by default; to land the proceeds elsewhere, add `--token-out`/`--chain-out` and the `eth` venue bridges the USDC onward in the same command (a non-USDC `--token-out` requires `--chain-out`). Onward delivery is eth-venue only — a `--chain sol` sell delivers USDC to your Solana wallet and stays there.

```bash
# Buy $5 of AAPL with USDC you hold (venue auto-picked)
acp trade --token AAPL --amount-usdc 5

# Buy funded from another chain — bridges VIRTUAL@Base → USDC, then buys
acp trade --token AAPL --token-in virtual --chain-in 8453 --amount-in 8

# Sell 0.01 AAPL shares (delivers USDC; --chain required on sells)
acp trade --token AAPL --amount-shares 0.01 --chain sol

# Sell 3 AAPL shares, receive the proceeds as USDC on Base (eth venue bridges onward)
acp trade --token AAPL --amount-shares 3 --chain eth --token-out usdc --chain-out 8453
# ...or as ETH on Arbitrum — a non-USDC --token-out requires --chain-out (chain never guessed)
acp trade --token AAPL --amount-shares 3 --chain eth --token-out eth --chain-out 42161
```

**Hyperliquid — perps:**

Hyperliquid perps aren't limited to crypto — it lists leveraged perp markets across **crypto, equities/stocks, FX/currencies, and commodities**. The command is the same for all of them: pass the Hyperliquid market symbol as `--token`, and `--side`, `--size`, and (optionally) `--leverage` work identically regardless of asset class.

```bash
# Market long 0.01 BTC with 5x leverage (crypto)
acp trade --side long --token BTC --size 0.01 --leverage 5

# Limit short 0.5 ETH at 4000, post-only
acp trade --side short --token ETH --size 0.5 --price 4000 --post-only

# Same shape for an equity, FX, or commodity perp — just change the symbol
acp trade --side long --token <HL_MARKET_SYMBOL> --size 1 --leverage 3

# Close (part of) a position: --reduce-only with --side OPPOSITE to the position.
# Closing a LONG is a SHORT order; closing a SHORT is a LONG order.
acp trade --side short --token BTC --size 0.01 --reduce-only   # closes a BTC long
acp trade --side long --token BTC --size 0.01 --reduce-only    # closes a BTC short
```

> `--reduce-only` only shrinks an existing position — never set it when opening or
> adding. If the side matches the position (or there's no position), Hyperliquid
> rejects the order with "Reduce only order would increase position".

**Hyperliquid — account & withdraw:**

```bash
# Show Hyperliquid ACCOUNT status ONLY — HL perp positions, margin, and HL spot balances.
# This is the one HL-specific read. For on-chain token balances
# EVM chains + Solana), use `acp wallet balance` instead.
acp trade hl-status

# Withdraw USDC off Hyperliquid (settles to Arbitrum; --to-chain bridges onward)
acp trade withdraw-from-hl --amount 25
acp trade withdraw-from-hl --amount 25 --destination 0xRecipient
acp trade withdraw-from-hl --amount 25 --to-chain 8453   # bridge onward to Base
```

> For agents: always pass explicit flags (and `--json`). The interactive picker only runs in a terminal with no flags — agents must never rely on it.

## Job Lifecycle

State machine:

```
open → budget_set → funded → submitted → completed
  │                                    └──→ rejected
  └──→ expired
```

Client/provider sequence:

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

A provider can also propose a budget *with* a fund-transfer request using `provider set-budget-with-fund-request` — same `budget_set → funded → submitted` path with a separate token transfer attached.

## Project Structure

```
bin/
  acp.ts                    CLI entry point
  acp-cli-signer-*          Platform signer binaries (linux/macos/windows)
src/
  commands/
    configure.ts            Browser-based auth flow; saves token to OS keychain
    agent.ts                Agent management (create, list, use, whoami, add-signer, signer-policy, set-signer-policy, update, tokenize, migrate, register-erc8004)
    policy.ts               Wallet policy management (create, list, show, global; edit/delete deep-link to dashboard)
    offering.ts             Offering management (list, create, update, delete; subscription attachments)
    subscription.ts         Subscription management (list, create, update, delete)
    resource.ts             Resource management (list, create, update, delete)
    browse.ts               Browse/search available agents by query or chain
    client.ts               Client actions (create-job, create-custom-job, fund, complete, reject, review)
    provider.ts             Provider actions (set-budget, set-budget-with-fund-request, submit)
    job.ts                  Job queries (list, history, watch)
    message.ts              Chat messaging
    events.ts               NDJSON event streaming (listen, drain)
    wallet.ts               Wallet info, signing, transaction broadcast, topup
    chain.ts                Chain info (list supported chains)
    email.ts                Agent email (identity, inbox, compose, search, threads, attachments)
    card.ts                 Agent virtual cards (signup, profile, payment-method, limit, issue, 3ds)
    compute.ts              Agent compute account (status, top-up)
  lib/
    config.ts               Load/save config.json at ~/.config/acp/ (override with ACP_CONFIG_DIR)
    activeAgent.ts          Active-agent resolution helpers
    agentFactory.ts         Create ACP agent instance from config + OS keychain
    acpCliSigner.ts         Signer utilities (wraps platform signer binaries)
    browser.ts              Open-URL helper for OAuth / approval flows
    chains.ts               Chain metadata
    color.ts                picocolors wrapper
    dashboard.ts            Dashboard deep-link URLs for owner-signed policy ops (ACP_DASHBOARD_URL override)
    errors.ts               CliError class with structured codes
    prompt.ts               Interactive CLI helpers (prompt, select, table)
    output.ts               JSON / human-readable output formatting
    subscription.ts         Subscription helpers
    tokenize.ts             Tokenization helpers
    validation.ts           Shared JSON schema validation (AJV)
    compat/                 Legacy ACP SDK (v1) compatibility shims
    api/
      client.ts             Authenticated HTTP client
      auth.ts               Auth API (CLI login flow)
      agent.ts              Agent API (CRUD, offerings, resources, quorum/signer)
      policy.ts             Policy API (create/list/show policies, global presets, wallet signers)
      job.ts                Job API (queries, history)
```

### Key Storage

Private keys are generated via `@privy-io/node` and stored in your OS keychain (`cross-keychain`). Node.js never touches raw key material at rest — keys are only loaded from the keychain when signing is needed.

## License

ISC
