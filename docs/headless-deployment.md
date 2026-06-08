# Headless setup

Use this guide if you want to ship `acp-cli` pre-installed on the machines your end users sign in to, with no browser step on first launch. Typical setups: cloud servers, container images, managed devices, anywhere a person isn't going to open a browser to authenticate.

## Becoming a partner

To use the headless flow, you need to be onboarded as a **Virtuals partner**. We'll issue you an API key and walk you through the provisioning endpoint our team exposes for partners.

**Contact us to get started:**

Without partner credentials the CLI still works — just not headlessly. Anyone can run `acp configure` interactively and the browser flow takes care of the rest.

## How it works (in plain terms)

The end user's machine generates its own signing key locally and never reveals the private half to anyone. Your backend then asks the end user to sign a short consent message proving they approved this specific agent. With consent in hand, your backend creates the agent on Virtuals' side and returns CLI tokens that the machine plugs in.

```
  [end-user's machine]            [end user's wallet]            [your backend]              [virtuals]
        │                                 │                            │                          │
        │  1. acp agent generate-signer-key                            │                          │
        │ ──────────► generates P-256 keypair locally                  │                          │
        │                                                                                          
        │  2. publicKey ─────────────────► sign EIP-712 consent ──────►                          │
        │                                  (proves user owns           │                          │
        │                                   the wallet)                │                          │
        │                                                              │                          │
        │                                                  3. call Virtuals with:                │
        │                                                     { walletAddress,                    │
        │                                                       signerPublicKey,                  │
        │                                                       ownerSignature,                   │
        │                                                       issuedAt } ──────────────────────►│
        │                                                              │                          │
        │                                                              │   ◄─── { agentId,        │
        │                                                              │          wallet,         │
        │                                                              │          accessToken,    │
        │                                                              │          refreshToken }  │
        │                                                              │                          │
        │  4. tokens + agent details ◄─────────────────────────────────│                          │
        │                                                                                          
        │  5. acp configure (stores tokens)                                                       │
        │  6. acp agent link (records agent)                                                      │
```

The private half of the signing key never leaves the user's machine. Your backend doesn't see it. We don't see it. Only the holder of that machine can sign on behalf of the agent.

## Capturing the end user's consent

Before your backend can ask Virtuals to provision the agent, it needs a fresh EIP-712 signature from the end user's EVM wallet. This proves the user actually owns the address you're claiming and approves this specific signer being attached to their wallet.

### Typed-data shape

```ts
const domain = { name: 'Virtuals Partner', version: '1' };

const types = {
  PartnerAgentConsent: [
    { name: 'walletAddress',   type: 'address' },
    { name: 'signerPublicKey', type: 'string'  },
    { name: 'issuedAt',        type: 'uint256' },
  ],
};

const message = {
  walletAddress,                                   // end user's EVM wallet
  signerPublicKey,                                 // from step 1 above
  issuedAt: BigInt(Math.floor(Date.now() / 1000)), // unix seconds; ±10-min window
};
```

### Signing with `viem`

```ts
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(endUserPrivateKey);
// (or use a connected wallet: MetaMask, WalletConnect, embedded SDK, …)

const ownerSignature = await account.signTypedData({
  domain,
  types,
  primaryType: 'PartnerAgentConsent',
  message,
});

// Send `ownerSignature` (0x… hex) and `issuedAt` to Virtuals alongside
// walletAddress + signerPublicKey.
```

### Why each field is in there

- **`walletAddress`** — Virtuals checks the signature recovers to this exact address. Prevents you (or anyone with your API key) from registering agents under EVM addresses the user doesn't control.
- **`signerPublicKey`** — Binds the consent to the specific signer being attached. The same signature can't be reused later to attach a different signer.
- **`issuedAt`** — Virtuals rejects anything outside a ±10-minute window from server time. Stops stale signatures from being replayed.

### What the user sees

Modern wallets show structured EIP-712 fields, so the user's prompt looks like:

```
PartnerAgentConsent
  walletAddress:   0xAbC1234567890abcdef1234567890ABCDEF12345
  signerPublicKey: MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE…
  issuedAt:        1716624000
```

Readable enough that the user can verify the signing key matches what your UI claims, but compact enough not to overwhelm.

## The bootstrap from the machine's perspective

You'll have **two different wallet addresses** flowing through the bootstrap:

- **End user's wallet** — the EVM address (EOA) you set up the user with. Owns the agent. Used to key tokens locally.
- **Agent's wallet** — a separate EVM address Virtuals creates when the agent is provisioned. Used to identify the agent in the local config.

Once your backend has provisioned and returned the agent details, the bootstrap is four CLI calls:

```bash
# 1. Generate the keypair (run once, before contacting your backend).
acp agent generate-signer-key --json
# → { "publicKey": "MFkwEwYHK…" }

# 2. (your backend collects the consent signature and provisions the agent,
#     returning the values below)

# 3. Persist the tokens against the end user's wallet.
acp configure \
  --token         "$ACCESS_TOKEN" \
  --refresh-token "$REFRESH_TOKEN" \
  --wallet        "$END_USER_WALLET_ADDRESS"

# 4. Link the local keypair to the new agent (keyed by the agent's wallet).
acp agent link \
  --agent-id          "$AGENT_ID" \
  --wallet            "$AGENT_WALLET" \
  --signer-public-key "$PUBLIC_KEY" \
  --make-active
```

That's it — no browser opens, no human input required on the machine itself.

### Full bootstrap script

If you're injecting this into a first-boot script, the whole thing fits in one bash file. The script generates the keypair, asks **your** backend to collect the user's consent signature for that key, asks your backend to provision the agent (forwarding the signature and `issuedAt` so your backend can relay them to Virtuals), and wires the CLI up:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Values you inject from your provisioning system (secrets manager, env, etc.):
#   $PARTNER_CONSENT_URL        — your backend endpoint that collects the end
#                                 user's EIP-712 consent signature
#   $PARTNER_AGENT_CREATE_URL   — your backend endpoint that provisions an agent
#   $PARTNER_API_TOKEN          — credential the machine uses to call your backend
#   $END_USER_WALLET_ADDRESS    — the end user's EVM wallet address

# 1. Generate the keypair locally; private half stays on the machine.
PUBLIC_KEY=$(acp agent generate-signer-key --json | jq -r .publicKey)

# 2. Ask your backend to collect the end user's EIP-712 consent over this
#    public key (e.g. a wallet prompt in your own UI). The consent signs over
#    the public key, so this can only happen AFTER step 1 — and Virtuals
#    only accepts the signature within ±10 minutes of issuedAt, so it can't
#    be collected ahead of time either. Your backend must return both the
#    signature and the exact issuedAt that was signed.
CONSENT=$(curl --fail -sS -X POST "$PARTNER_CONSENT_URL" \
  -H "Authorization: Bearer $PARTNER_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"walletAddress\":\"$END_USER_WALLET_ADDRESS\",\"signerPublicKey\":\"$PUBLIC_KEY\"}")

OWNER_SIGNATURE=$(jq -r .ownerSignature <<<"$CONSENT")
ISSUED_AT=$(jq       -r .issuedAt       <<<"$CONSENT")

# 3. Ask your backend to provision the agent, forwarding the consent proof.
#    Your backend relays this (plus the agent's name/description) to Virtuals.
PROVISION=$(curl --fail -sS -X POST "$PARTNER_AGENT_CREATE_URL" \
  -H "Authorization: Bearer $PARTNER_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"walletAddress\":\"$END_USER_WALLET_ADDRESS\",\"signerPublicKey\":\"$PUBLIC_KEY\",\"ownerSignature\":\"$OWNER_SIGNATURE\",\"issuedAt\":$ISSUED_AT}")

ACCESS_TOKEN=$(jq  -r .accessToken        <<<"$PROVISION")
REFRESH_TOKEN=$(jq -r .refreshToken       <<<"$PROVISION")
AGENT_ID=$(jq      -r .data.id            <<<"$PROVISION")
AGENT_WALLET=$(jq  -r .data.walletAddress <<<"$PROVISION")

# 4. Persist the tokens against the end user's wallet.
acp configure \
  --token         "$ACCESS_TOKEN" \
  --refresh-token "$REFRESH_TOKEN" \
  --wallet        "$END_USER_WALLET_ADDRESS"

# 5. Link the local keypair to the agent and make it active.
acp agent link \
  --agent-id          "$AGENT_ID" \
  --wallet            "$AGENT_WALLET" \
  --signer-public-key "$PUBLIC_KEY" \
  --make-active
```

The request/response shape between the machine and your backend is yours to design — the consent collection (step 2) and the provisioning relay (step 3) can be one endpoint or two, as long as the `ownerSignature` + `issuedAt` pair reaches Virtuals together with the `walletAddress` and `signerPublicKey` it signs over (plus the agent's name and description). Just be careful with the two wallet addresses: `acp configure --wallet` takes the end user's wallet; `acp agent link --wallet` takes the agent's wallet.

### Env-var alternative

Instead of passing flags, you can set:

```
ACP_ACCESS_TOKEN     # access token from your provisioning response
ACP_REFRESH_TOKEN    # refresh token from your provisioning response
ACP_OWNER_WALLET     # the end user's wallet address (not the agent's)
```

…and run `acp configure` with no flags. Same effect as `--token / --refresh-token / --wallet`.

## Verifying the setup

After the four commands run, the CLI is fully usable. Quick sanity checks:

```bash
acp agent whoami     # shows the active agent's name and wallet
acp agent list       # makes an authenticated call to Virtuals
```

If anything looks off, the most common cause is a mismatch between the public key the CLI signed with locally and the one your backend told us about — re-run `generate-signer-key` and `link` with the new public key.

## Multiple agents, multiple users

Two different things, two different patterns.

**One end user, several agents.** Use one profile. The access token is user-scoped — it authenticates the user across all of their agents. Run the bootstrap once per agent (each `acp agent link` adds a new entry under the agent's wallet address), then switch between them with:

```bash
acp agent use <agentWalletAddress>
```

No `ACP_CONFIG_DIR` needed.

**Several end users on the same machine.** Each user has different tokens and a different owner wallet, so each one needs their own profile. Use `ACP_CONFIG_DIR` to isolate them:

```bash
ACP_CONFIG_DIR=~/.config/acp/alice acp …
ACP_CONFIG_DIR=~/.config/acp/bob   acp …
```

Each profile has its own `config.json`, its own keys in the keychain, and its own active agent.
