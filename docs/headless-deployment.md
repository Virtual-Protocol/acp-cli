# Headless setup

Use this guide if you want to ship `acp-cli` pre-installed on the machines your end users sign in to, with no browser step on first launch. Typical setups: cloud servers, container images, managed devices, anywhere a person isn't going to open a browser to authenticate.

## Becoming a partner

To use the headless flow, you need to be onboarded as a **Virtuals partner**. We'll issue you an API key and walk you through the provisioning endpoint our team exposes for partners.

**Contact us to get started:**

Without partner credentials the CLI still works — just not headlessly. Anyone can run `acp configure` interactively and the browser flow takes care of the rest.

## How it works (in plain terms)

The end user's machine generates its own signing key locally and never reveals the private half to anyone. Your backend creates the agent on Virtuals' side using just the public half. The end user then plugs the returned tokens and agent details into their local CLI in one step.

```
  [end-user's machine]                         [your backend]                       [virtuals]
        │                                            │                                  │
        │  1. acp agent generate-signer-key          │                                  │
        │ ─────────────► generates keypair locally   │                                  │
        │                                            │                                  │
        │  2. publicKey ─────────────────────────► creates agent on the user's behalf ► │
        │                                            │ ◄────── { agentId, wallet,       │
        │                                            │           accessToken,           │
        │                                            │           refreshToken }         │
        │                                            │                                  │
        │  3. tokens + agent details ◄───────────────│                                  │
        │                                            │                                  │
        │  4. acp configure (stores tokens)          │                                  │
        │  5. acp agent link (records agent)         │                                  │
```

The private half of the signing key never leaves the user's machine. Your backend doesn't see it. We don't see it. Only the holder of that machine can sign on behalf of the agent.

## The four commands the machine runs

You'll have **two different wallet addresses** flowing through the bootstrap:

- **End user's wallet** — the EVM address (EOA) you set up the user with. Owns the agent. Used to key tokens locally.
- **Agent's wallet** — a separate EVM address Virtuals creates when the agent is provisioned. Used to identify the agent in the local config.

Once your backend has returned the agent details to the machine, the bootstrap is four CLI calls:

```bash
# 1. Generate the keypair (run once, before contacting your backend).
acp agent generate-signer-key --json
# → { "publicKey": "MFkwEwYHK…" }

# 2. (your backend uses that publicKey to provision the agent, returning the values below)

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

That's it — no browser opens, no human input required.

### Full bootstrap script

If you're injecting this into a first-boot script, the whole thing fits in one bash file. The script generates the keypair, asks **your** backend to provision the agent (your backend then talks to Virtuals on the machine's behalf), and wires the CLI up:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Values you inject from your provisioning system (secrets manager, env, etc.):
#   $PARTNER_AGENT_CREATE_URL   — your backend endpoint that provisions an agent
#   $PARTNER_API_TOKEN          — credential the machine uses to call your backend
#   $END_USER_WALLET_ADDRESS    — the end user's EVM wallet address

# 1. Generate the keypair locally; private half stays on the machine.
PUBLIC_KEY=$(acp agent generate-signer-key --json | jq -r .publicKey)

# 2. Ask your backend to provision the agent. Your backend forwards the
#    public key to Virtuals and returns the tokens + agent details.
PROVISION=$(curl --fail -sS -X POST "$PARTNER_AGENT_CREATE_URL" \
  -H "Authorization: Bearer $PARTNER_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"walletAddress\":\"$END_USER_WALLET_ADDRESS\",\"signerPublicKey\":\"$PUBLIC_KEY\"}")

ACCESS_TOKEN=$(jq  -r .accessToken        <<<"$PROVISION")
REFRESH_TOKEN=$(jq -r .refreshToken       <<<"$PROVISION")
AGENT_ID=$(jq      -r .data.id            <<<"$PROVISION")
AGENT_WALLET=$(jq  -r .data.walletAddress <<<"$PROVISION")

# 3. Persist the tokens against the end user's wallet.
acp configure \
  --token         "$ACCESS_TOKEN" \
  --refresh-token "$REFRESH_TOKEN" \
  --wallet        "$END_USER_WALLET_ADDRESS"

# 4. Link the local keypair to the agent and make it active.
acp agent link \
  --agent-id          "$AGENT_ID" \
  --wallet            "$AGENT_WALLET" \
  --signer-public-key "$PUBLIC_KEY" \
  --make-active
```

The request/response shape between the machine and your backend is yours to design. The example above mirrors what Virtuals returns, which keeps the script trivially thin — your backend can simply forward the response back. Just be careful with the two wallet addresses: `acp configure --wallet` takes the end user's wallet; `acp agent link --wallet` takes the agent's wallet.

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

