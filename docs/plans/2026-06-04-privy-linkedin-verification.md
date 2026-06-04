# Privy LinkedIn Verification Flow Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Secure the `acp compute apply` credit application flow by integrating Privy-backed LinkedIn OAuth verification directly within the CLI to prevent Sybil attacks and verify real developers.

**Architecture:** The CLI queries the backend to generate a temporary, secure Privy-backed LinkedIn authorization URL, opens the URL in the developer's default browser, and executes a non-blocking 3-minute polling loop to extract their cryptographically verified LinkedIn profile before completing the application.

**Tech Stack:** TypeScript, Node.js, Commander.js, open (browser launcher), and Privy Node SDK.

---

### Task 1: Add LinkedIn Verification Endpoints to AgentApi

**Objective:** Extend the `AgentApi` class with endpoints to request the Privy LinkedIn verification URL and poll the verification status.

**Files:**
- Modify: `src/lib/api/agent.ts`
- Test: `src/lib/api/__tests__/agent.test.ts` (or equivalent test suite if exists)

**Step 1: Write failing test / mock interface**
Verify the endpoints match the desired payload and structures:

```typescript
// Test shape in src/lib/api/__tests__/agent.test.ts
import { AgentApi } from "../agent";
import { ApiClient } from "./client";

describe("AgentApi - LinkedIn Verification", () => {
  it("should request the correct verify url endpoint", async () => {
    const mockClient = {
      get: jest.fn().mockResolvedValue({
        data: { verifyUrl: "https://auth.privy.io/verify", requestId: "req-123" }
      })
    } as unknown as ApiClient;
    
    const api = new AgentApi(mockClient);
    const res = await api.getLinkedInVerifyUrl("agent-abc");
    expect(mockClient.get).toHaveBeenCalledWith("/developer-campaign/agents/agent-abc/linkedin-verify-url");
    expect(res).toEqual({ verifyUrl: "https://auth.privy.io/verify", requestId: "req-123" });
  });
});
```

**Step 2: Run test to verify failure**
Run: `npm test` or verify build failure due to missing types.

**Step 3: Write minimal implementation**
Append the new methods inside `export class AgentApi` (around line 1250+ in `src/lib/api/agent.ts`):

```typescript
  /**
   * Generates a temporary Privy authorization URL for the developer to authenticate their LinkedIn.
   */
  async getLinkedInVerifyUrl(agentId: string): Promise<{ verifyUrl: string; requestId: string }> {
    const res = await this.client.get<{ data: { verifyUrl: string; requestId: string } }>(
      `/developer-campaign/agents/${agentId}/linkedin-verify-url`
    );
    return res.data;
  }

  /**
   * Polls the API to check if the developer has completed the LinkedIn handshake.
   */
  async checkLinkedInStatus(agentId: string, requestId: string): Promise<{ verified: boolean; url?: string }> {
    const res = await this.client.get<{ data: { verified: boolean; url?: string } }>(
      `/developer-campaign/agents/${agentId}/linkedin-status`,
      { requestId }
    );
    return res.data;
  }
```

**Step 4: Run test to verify pass**
Run: `npm run build && npm run typecheck`
Expected: PASS

**Step 5: Commit**
```bash
git add src/lib/api/agent.ts
git commit -m "feat: add linkedin verification endpoints to AgentApi"
```

---

### Task 2: Implement Secure OAuth Polling & Fallback in compute.ts

**Objective:** Integrate the browser open command and the non-blocking polling loop inside the interactive `acp compute apply` TTY flow.

**Files:**
- Modify: `src/commands/compute.ts`

**Step 1: Write failing test**
Examine how `apply` is structured and prepare the replacement logic for TTY prompt inputs.

**Step 2: Run test to verify failure**
Verify TypeScript compilation errors or manual CLI invocation throws on old manual entry.

**Step 3: Write minimal implementation**
Locate the `linkedin` question line around line 234 in `src/commands/compute.ts`:
```typescript
          linkedin = await askQuestion("  [4/6] LinkedIn Profile URL", linkedin);
```
Replace it with the dynamic Privy LinkedIn authentication and polling flow (including graceful fallback to manual entry if the API/OAuth is offline):

```typescript
          console.log(`\n  [4/6] ${c.bold("LinkedIn Authentication (Security Verification)")}`);
          console.log(`        To protect credit pools, we use cryptographically verified LinkedIn profiles.`);
          
          try {
            const { verifyUrl, requestId } = await agentApi.getLinkedInVerifyUrl(agentId);
            
            console.log(`\n  ${c.cyan("👉 Please authenticate and authorize at this link:")}`);
            console.log(`     ${c.underline(verifyUrl)}\n`);
            
            // Open default system browser dynamically
            const openModule = await import("open");
            await openModule.default(verifyUrl);
            
            console.log(`  ${c.yellow("⌛ Waiting for LinkedIn verification... (3-minute timeout)")}`);
            
            let verifiedUrl: string | undefined;
            const timeout = 180000; // 3 minutes
            const startTime = Date.now();
            
            while (Date.now() - startTime < timeout) {
              const status = await agentApi.checkLinkedInStatus(agentId, requestId);
              if (status.verified && status.url) {
                verifiedUrl = status.url;
                break;
              }
              await new Promise((r) => setTimeout(r, 4000)); // Poll every 4 seconds
            }
            
            if (!verifiedUrl) {
              throw new Error("Verification timed out or was cancelled by user.");
            }
            
            linkedin = verifiedUrl;
            console.log(`  ✅ ${c.green("Successfully Verified LinkedIn!")} Profile: ${linkedin}`);
            
          } catch (err: any) {
            console.log(`  ❌ ${c.red(`LinkedIn Auth Fallback: ${err.message}`)}`);
            linkedin = await askQuestion("     Enter LinkedIn Profile URL (Manual Entry Fallback)", linkedin);
          }
```

**Step 4: Run test to verify pass**
Run: `npm run build && npm run typecheck`
Expected: PASS with zero compile errors.

**Step 5: Commit**
```bash
git add src/commands/compute.ts
git commit -m "feat: integrate privy-linkedin verify and polling flow inside compute apply command"
```

---

### Task 3: Verify Entire E2E Workflow

**Objective:** Verify the new command options and ensure compiling compiles flawlessly.

**Files:**
- Create/Run: `scripts/verify-apply.ts` (throwaway verification script)

**Step 1: Write failing test**
Build and verify the local global executable:
```bash
npm run build
```

**Step 2: Run local test**
Test the command structure output:
```bash
node dist/bin/acp.js compute apply --help
```
Expected output: Includes `--linkedin` and correct option bindings.

**Step 3: Commit and push changes**
```bash
git push origin feat/acp-compute-apply
```
