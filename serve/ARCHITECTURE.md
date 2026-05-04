# ACP Serve Architecture

ACP Serve turns a developer's `handler.ts` into one provider runtime that can serve:

- direct ACP jobs from the ACP registry
- direct x402 jobs through `agentic-commerce-be`
- direct MPP jobs through `agentic-commerce-be`

For v1, x402 and MPP do not settle through ERC-8183. The `--settle-8183` flag is reserved, but disabled until the contract supports the needed flow.

## Runtime Model

The provider runtime does not expose public x402 or MPP payment endpoints.

Instead:

1. The provider runs `acp serve start` locally or in a hosted deployment.
2. The runtime authenticates as the provider agent and opens an outbound Socket.IO connection to `agentic-commerce-be` namespace `/service-jobs`.
3. Clients call canonical BE endpoints:
   - `/x402/:providerAddress/jobs/:offeringName`
   - `/mpp/:providerAddress/jobs/:offeringName`
4. BE asks the provider runtime to build the protocol-specific 402 challenge.
5. The client retries the same BE endpoint with the x402 payment header or MPP authorization header.
6. BE creates/idempotently claims the service job and relays the raw payment credential over the provider's outbound socket.
7. The provider runtime verifies and settles the payment with the protocol SDK, then calls the developer's `handler.ts`.
8. The runtime returns the deliverable, protocol response headers, and settlement metadata as the socket ack.
9. BE stores the result and returns the deliverable to the client in the same paid HTTP request.

This keeps provider infrastructure private and self-hostable while preserving stable public x402/MPP endpoints.

## Payment Roles

The provider runtime is the x402/MPP resource server and settlement actor.

- x402: the client signs an EIP-3009 authorization. The provider runtime verifies it and broadcasts `transferWithAuthorization` with the provider deployment signer as the gas sponsor. Funds move client -> provider.
- MPP: the client submits a tempo credential. The provider runtime verifies/settles it with `mppx` and the provider deployment signer as fee payer. Funds move client -> provider.
- BE: owns public URLs, job idempotency, socket routing, and persistence. It does not hold payment credentials, facilitator credentials, or an ops settlement wallet.

No separate external facilitator service is required.

## CLI Responsibilities

`acp serve init` scaffolds the local service files:

- `handler.ts`: required service implementation
- `budget.ts`: optional ACP-native budget hook
- `offering.json`: registry offering metadata
- `serve.json`: local runtime config

`acp serve start`:

- loads the selected offering handler
- authenticates as the active provider agent
- connects to BE `/service-jobs`
- listens for `service-job:payment-challenge`
- listens for `service-job:request`
- verifies/settles x402 or MPP credentials before running the handler
- returns `{ status: "completed", deliverable, headers, settlement }` or `{ status: "failed", error }`
- optionally runs the native ACP listener for ACP registry jobs

`acp serve endpoints` prints canonical BE x402/MPP endpoints, not localhost payment endpoints.

`acp serve deploy` packages the same runtime for a provider adapter such as Railway. The deployed runtime still connects outbound to BE.

## Signers

The BE does not need the provider's signer or wallet private key.

The provider runtime needs provider signing capability to authenticate as the agent, settle x402/MPP payments, and for ACP-native jobs interact with ACP. Hosted deployments can use a scoped deploy signer for that runtime. That signer is never sent to BE.

## Future 8183 Settlement

`--settle-8183` and `SETTLE_8183_ACP` remain reserved. Once the ERC-8183 contract supports the missing functions, the provider runtime can settle x402/MPP-backed ACP jobs without changing the developer's `handler.ts` contract.
