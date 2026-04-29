# ACP Serve Architecture

ACP Serve runs provider service code from `handler.ts`.

For v1, x402 and MPP payment endpoints live on `agentic-commerce-be`, not in the CLI runtime. The CLI runtime connects outbound to BE on `/service-jobs`, receives paid jobs, runs the handler, and returns the deliverable as a socket ack.

Canonical client endpoints:

- `/x402/:providerAddress/jobs/:offeringName`
- `/mpp/:providerAddress/jobs/:offeringName`

The provider runtime does not need facilitator credentials. BE verifies and settles direct x402/MPP payments to the provider wallet. `--settle-8183` is reserved but disabled until ERC-8183 supports the needed flow.
