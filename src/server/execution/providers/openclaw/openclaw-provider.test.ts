import { beforeEach, describe, expect, it, vi } from "vitest";

const envMocks = vi.hoisted(() => ({
  gatewayConfigured: true,
  defaultAgentId: "hubconnect",
  timeoutSeconds: 120,
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    OPENCLAW_DEFAULT_AGENT_ID: envMocks.defaultAgentId,
    OPENCLAW_TIMEOUT_SECONDS: envMocks.timeoutSeconds,
  }),
  isIntegrationConfigured: (key: string) =>
    key === "OPENCLAW_GATEWAY" ? envMocks.gatewayConfigured : false,
}));

const prismaMocks = vi.hoisted(() => ({
  findUniqueProject: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { project: { findUnique: prismaMocks.findUniqueProject } },
}));

vi.mock("@/server/repositories/browser-profile.repository", () => ({
  BrowserProfileRepository: { findByIdInProject: vi.fn() },
}));

const gatewayMocks = vi.hoisted(() => ({
  startAgentRun: vi.fn(),
  sendFollowUp: vi.fn(),
  getRunState: vi.fn(),
}));
vi.mock(
  "@/server/execution/providers/openclaw/openclaw-gateway-client",
  () => ({
    OpenClawGatewayClient: {
      get isConfigured() {
        return envMocks.gatewayConfigured;
      },
      startAgentRun: gatewayMocks.startAgentRun,
      sendFollowUp: gatewayMocks.sendFollowUp,
      getRunState: gatewayMocks.getRunState,
    },
  }),
);

import { OpenClawProvider } from "@/server/execution/providers/openclaw/openclaw-provider";
import type {
  ExecutionPolicyContext,
  ExecutionRequest,
} from "@/server/execution/types";

const context: ExecutionPolicyContext = {
  workspaceId: "ws-1",
  projectId: "project-1",
  brandId: "brand-1",
  taskId: "task-1",
  capability: "WEB_RESEARCH",
  riskLevel: "LOW",
};

describe("OpenClawProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMocks.gatewayConfigured = true;
  });

  describe("canExecute", () => {
    it("returns false when the Gateway is not configured", async () => {
      envMocks.gatewayConfigured = false;
      const provider = new OpenClawProvider();
      expect(await provider.canExecute("WEB_RESEARCH", context)).toBe(false);
    });

    it("returns false for a capability it does not own", async () => {
      const provider = new OpenClawProvider();
      expect(await provider.canExecute("EMAIL_SEND", context)).toBe(false);
    });

    // BRAND_DISCOVERY isn't in execution-policy.ts's
    // BROWSER_PURPOSE_BY_CAPABILITY map, so requiresBrowserProfile() is
    // false for it — unlike WEB_RESEARCH/SOCIAL_RESEARCH/etc, which DO map
    // to the PUBLIC_RESEARCH purpose and so still require a profile.
    it("allows a capability with no static browser-purpose mapping without a profile", async () => {
      const provider = new OpenClawProvider();
      expect(await provider.canExecute("BRAND_DISCOVERY", context)).toBe(true);
    });

    // INSTAGRAM_PUBLISH is still mapped to the "INSTAGRAM" browser purpose
    // in execution-policy.ts (unlike TIKTOK_PUBLISH/LINKEDIN_PUBLISH/X_PUBLISH,
    // which were deliberately removed from that map once they got real OAuth
    // providers — see execution-policy.ts's comment).
    it("requires a browser profile for a policy-bound capability", async () => {
      const provider = new OpenClawProvider();
      expect(await provider.canExecute("INSTAGRAM_PUBLISH", context)).toBe(
        false,
      );
      expect(
        await provider.canExecute("INSTAGRAM_PUBLISH", {
          ...context,
          browserProfileId: "profile-1",
        }),
      ).toBe(true);
    });
  });

  describe("execute / getStatus", () => {
    it("returns immediately after the Gateway accepts the run, without waiting for completion", async () => {
      gatewayMocks.startAgentRun.mockResolvedValue({ runId: "run-abc" });

      const provider = new OpenClawProvider();
      const request: ExecutionRequest = {
        executionJobId: "job-1",
        correlationId: "corr-1",
        idempotencyKey: "task-1:WEB_RESEARCH",
        capability: "WEB_RESEARCH",
        context,
        payload: { request: "find competitor pricing" },
      };

      const accepted = await provider.execute(request);
      expect(accepted).toEqual({
        executionReference: "corr-1",
        isMock: false,
      });
      expect(gatewayMocks.startAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "hubconnect",
          sessionKey: "corr-1",
          idempotencyKey: "corr-1",
        }),
      );
    });

    it("reports RUNNING while the Gateway run has no terminal event yet", async () => {
      gatewayMocks.startAgentRun.mockResolvedValue({ runId: "run-abc" });
      gatewayMocks.getRunState.mockReturnValue({ kind: "running" });

      const provider = new OpenClawProvider();
      await provider.execute({
        executionJobId: "job-1",
        correlationId: "corr-1",
        idempotencyKey: "task-1:WEB_RESEARCH",
        capability: "WEB_RESEARCH",
        context,
        payload: {},
      });

      const status = await provider.getStatus("corr-1");
      expect(status).toEqual({ status: "RUNNING", isMock: false });
    });

    it("normalizes a terminal Gateway result into COMPLETED", async () => {
      gatewayMocks.startAgentRun.mockResolvedValue({ runId: "run-abc" });
      gatewayMocks.getRunState.mockReturnValue({
        kind: "done",
        result: { ok: true, runId: "run-abc", finalText: "done" },
      });

      const provider = new OpenClawProvider();
      await provider.execute({
        executionJobId: "job-1",
        correlationId: "corr-1",
        idempotencyKey: "task-1:WEB_RESEARCH",
        capability: "WEB_RESEARCH",
        context,
        payload: {},
      });

      const status = await provider.getStatus("corr-1");
      expect(status.status).toBe("COMPLETED");
      expect(status.isMock).toBe(false);
    });

    it("returns FAILED for an unknown execution reference", async () => {
      const provider = new OpenClawProvider();
      const status = await provider.getStatus("never-executed");
      expect(status.status).toBe("FAILED");
    });
  });

  describe("resume", () => {
    it("sends the human's answer as a follow-up on the same session", async () => {
      gatewayMocks.startAgentRun.mockResolvedValue({ runId: "run-abc" });
      gatewayMocks.sendFollowUp.mockResolvedValue({ runId: "run-def" });
      gatewayMocks.getRunState.mockReturnValue({
        kind: "done",
        result: {
          ok: true,
          runId: "run-def",
          finalText: "resumed successfully",
        },
      });

      const provider = new OpenClawProvider();
      await provider.execute({
        executionJobId: "job-1",
        correlationId: "corr-1",
        idempotencyKey: "task-1:WEB_RESEARCH",
        capability: "WEB_RESEARCH",
        context,
        payload: {},
      });

      await provider.resume("corr-1", { value: "123456" });

      expect(gatewayMocks.sendFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "hubconnect",
          sessionKey: "corr-1",
          message: "123456",
        }),
      );
      // getStatus now reads the NEW runId returned by sendFollowUp.
      const status = await provider.getStatus("corr-1");
      expect(status.status).toBe("COMPLETED");
      expect(gatewayMocks.getRunState).toHaveBeenCalledWith(
        "run-def",
        expect.any(Number),
      );
    });

    it("is a no-op for an unknown execution reference", async () => {
      const provider = new OpenClawProvider();
      await provider.resume("never-executed", { value: "x" });
      expect(gatewayMocks.sendFollowUp).not.toHaveBeenCalled();
    });
  });
});
