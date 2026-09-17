# Tokenization

The `acp agent tokenize` command launches a token for the **active agent**.

## Prerequisites

1. An active agent is set — run `acp agent use` if you haven't.
2. A signer is registered for the active agent — run `acp agent add-signer` if you haven't. `tokenize` will refuse to run without a signer.
3. The agent wallet has enough **VIRTUAL** to cover the launch fee (plus any pre-buy amount). *(Virtuals launchpad only — Occupy charges no launch fee; see [Occupy](#occupy-launchpad).)*
4. The agent wallet has enough **ETH** to cover gas fees for the on-chain transactions, unless gas is sponsored for it.

## Chain selection

The available chains come from the EVM provider attached to the active agent. You can:

- Pass `--chain-id <id>` to pick explicitly. Must be one of the provider's supported chains.
- Omit it to be prompted (or auto-selected when only one chain is available).

## Anti-sniper protection

Anti-sniper applies a temporary transfer tax to newly launched tokens to discourage sniper bots from buying in the first seconds/minutes.

| Value | Label      | Duration |
| ----- | ---------- | -------- |
| `0`   | None       | Off      |
| `1`   | 60 seconds | Default  |
| `2`   | 98 minutes | Extended |

## Pre-buy

At launch, the agent wallet can atomically buy some of its own freshly minted agent token in the same `preLaunch` transaction by spending extra VIRTUAL on top of the launch fee.

- `--prebuy <virtuals>` — amount of VIRTUAL tokens to spend at launch (whole units, e.g. `100` = 100 VIRTUAL).
- Omitted or `0` → no pre-buy.
- Before sending any transaction, the CLI checks that the agent wallet holds at least `launchFee + prebuy` VIRTUAL and aborts with a clear message if not.

## Capital Formation (ACF)

ACF is an optional boolean toggle at launch. When enabled:

- The on-chain launch fee is higher (an ACF surcharge is added on top of the base fee). The CLI shows the total fee before proceeding.
- Additional features are auto-enabled (dev allocation tokenomics, sell wall).
- Pre-buy is capped at ≤50% of the LP. If you exceed this with `--prebuy`, the transaction will fail and the CLI will show a hint.

No other user input is required — it's a pure yes/no switch.

## 60 Days Experiment

A reversible launch mode for early-stage founders to test product/market fit over a 60-day commitment window. Enable with `--60-days`.

- **No launch-fee impact.**
- **Pre-buy cliff:** pre-purchased tokens follow a **60-day cliff** (instead of the standard 1-month cliff) when this mode is on.
- **Compatible with `--acf` and `--prebuy`.** Both can be combined with `--60-days`.
- **Growth Allocation Pool is web-UI only.** The Growth Allocation Pool sub-feature (allocate 0–5% of team stack as a separate pool for USDC deposits at a target FDV; auto-enables ACF) is not exposed in the CLI. To launch with a Growth Pool, use the web app at [app.virtuals.io](https://app.virtuals.io) → create agent → enable the **60 Days Experiment** toggle → check **"I want to include Growth Allocation Pool"**.

It's a pure yes/no switch — no other CLI input required.

## Airdrop Distribution

At launch, you can allocate 0–5% of the agent token supply to veVIRTUAL holders. Recipients are derived post-launch from a veVIRTUAL snapshot - no recipient list is required at CLI time.

- `--airdrop-percent <percent>` — decimal in `[0, 5]`, e.g. `1.25`, `2.5`. Omitted or `0` → no airdrop.
- **No launch-fee impact.**

## Robotics Launch

Marks the virtual as an **Embodied** (robotics-capable) agent and makes it eligible for **Eastworld** — the Virtuals robot fleet and physical testing environment. A "Robotics Launch" badge is shown on the agent's detail page.

- `--robotics` — presence-only boolean flag. Omitted → off.
- **No launch-fee impact.**
- **Eastworld onboarding is post-launch.** Once the flag is set, use [app.virtuals.io](https://app.virtuals.io) (or the partnerships team) to complete Eastworld onboarding. There is no CLI command for the physical onboarding flow.
- **Compatible with all other flags** (`--acf`, `--60-days`, `--airdrop-percent`, `--prebuy`, `--anti-sniper`). No mutual exclusions apply.

## Occupy launchpad

`--launchpad occupy` launches on **Occupy** instead of the Virtuals launchpad. Everything above (ACF, 60 Days, airdrop, Robotics) is Virtuals-specific and is **rejected** rather than silently ignored when combined with `--launchpad occupy`.

Occupy differs in three ways that matter at the CLI:

- **Single-phase and free.** One `launch` call mints the token, opens the Uniswap v4 pool and settles the pre-buy. There is no launch fee, so the agent wallet needs no VIRTUAL — only gas, which is sponsored for ACP agent wallets.
- **The curve is quoted in an arbitrary asset**, not VIRTUAL. `--quote-token <address>` picks it. The asset must be allow-listed on Occupy's `AssetConfig`; the backend checks before creating anything and fails with a clear message otherwise. Note that **WETH is not allow-listed** — the allowed assets are tokenized equities.
- **A pre-buy is denominated in the quote asset**, whose decimals need not be 18. The CLI reads the token's decimals to convert `--prebuy`, so `--prebuy` on Occupy requires `--quote-token`.

Occupy runs on EVM chains only; Solana launches go through the Virtuals launchpad.

| Flag | Default | Notes |
| --- | --- | --- |
| `--quote-token <address>` | backend default for the chain | Must be allow-listed on AssetConfig |
| `--pool-fee <fee>` | `10000` | Uniswap v4 pool fee in hundredths of a bip; on-chain bounds are 10000 (1%) – 30000 (3%) |
| `--tax-bips <bips>` | `100` | Trading tax, in bips |
| `--no-thicken-liquidity` | thickening on | Disables liquidity thickening |
| `--anti-sniper <0\|1\|2>` | `1` | Same meaning as above |
| `--prebuy <amount>` | none | In **quote-token** units, not VIRTUAL. Requires `--quote-token` |

```bash
# Launch on Occupy against an allow-listed quote asset
acp agent tokenize --launchpad occupy --chain-id 8453 --symbol MYTOKEN \
  --quote-token 0xb20000000000000000000078ee7ce2fE4908108C

# 3% pool fee, no liquidity thickening
acp agent tokenize --launchpad occupy --chain-id 8453 --symbol MYTOKEN \
  --quote-token 0xb20000000000000000000078ee7ce2fE4908108C \
  --pool-fee 30000 --no-thicken-liquidity

# Pre-buy 5 units of the quote asset at launch
acp agent tokenize --launchpad occupy --chain-id 8453 --symbol MYTOKEN \
  --quote-token 0xb20000000000000000000078ee7ce2fE4908108C --prebuy 5
```

## CLI usage

```
acp agent tokenize [--chain-id <id>] [--symbol <symbol>] [--anti-sniper <0|1|2>] [--prebuy <virtuals>] [--acf] [--60-days] [--airdrop-percent <percent>] [--robotics] [--configure]
acp agent tokenize --launchpad occupy [--chain-id <id>] [--symbol <symbol>] [--quote-token <address>] [--pool-fee <fee>] [--tax-bips <bips>] [--no-thicken-liquidity] [--anti-sniper <0|1|2>] [--prebuy <amount>]
```

- `--chain-id <id>` — chain to launch on. Restricted to what the provider supports.
- `--symbol <symbol>` — token symbol (uppercased). Prompted if omitted.
- `--anti-sniper <0|1|2>` — set directly. Respected with or without `--configure`.
- `--prebuy <virtuals>` — VIRTUAL tokens to spend at launch. Respected with or without `--configure`.
- `--acf` — enable Capital Formation. Respected with or without `--configure`.
- `--60-days` — enable 60 Days Experiment mode. Respected with or without `--configure`.
- `--airdrop-percent <percent>` — airdrop allocation to veVIRTUAL holders (0–5). Respected with or without `--configure`.
- `--robotics` — mark as a Robotics (Eastworld-eligible) launch. Respected with or without `--configure`.
- `--launchpad <virtuals|occupy>` — launchpad to launch on. Defaults to `virtuals`. See [Occupy](#occupy-launchpad).
- `--configure` — interactive pickers for anti-sniper, pre-buy, ACF, 60 Days Experiment, airdrop, and Robotics (blank / `N` to skip). Skipped for values already passed via flags.

Without `--configure`, the defaults below apply automatically — the CLI will not prompt for these options. Only `--chain-id` and `--symbol` are prompted when omitted.

- Defaults: anti-sniper `1` (60 seconds), no pre-buy, ACF off, 60 Days Experiment off, no airdrop, Robotics off.

### Examples

```bash
# Default (60s anti-sniper, no pre-buy, no ACF), chain picked interactively if multiple
acp agent tokenize

# Launch on a specific chain
acp agent tokenize --chain-id 8453 --symbol MYTOKEN

# Disable anti-sniper
acp agent tokenize --anti-sniper 0

# Pre-buy 100 VIRTUAL of the new token
acp agent tokenize --chain-id 8453 --symbol MYTOKEN --prebuy 100

# Enable Capital Formation
acp agent tokenize --chain-id 8453 --symbol MYTOKEN --acf

# ACF + pre-buy (stay ≤50% of LP)
acp agent tokenize --chain-id 8453 --symbol MYTOKEN --acf --prebuy 50

# Enable 60 Days Experiment
acp agent tokenize --chain-id 8453 --symbol MYTOKEN --60-days

# 60 Days Experiment + ACF + pre-buy
acp agent tokenize --chain-id 8453 --symbol MYTOKEN --60-days --acf --prebuy 50

# Airdrop 2.5% of supply to veVIRTUAL holders
acp agent tokenize --chain-id 8453 --symbol MYTOKEN --airdrop-percent 2.5

# Airdrop + pre-buy (airdrop reduces pre-buy headroom)
acp agent tokenize --chain-id 8453 --symbol MYTOKEN --airdrop-percent 1 --prebuy 50

# Robotics Launch (Eastworld-eligible)
acp agent tokenize --chain-id 8453 --symbol MYTOKEN --robotics

# Pick anti-sniper, pre-buy, ACF, 60 Days Experiment, airdrop, and Robotics interactively
acp agent tokenize --configure
```
