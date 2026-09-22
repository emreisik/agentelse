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
  findUniqueExecutionJob: vi.fn(),
  updateExecutionJob: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: prismaMocks.findUniqueProject },
    executionJob: {
      findUnique: prismaMocks.findUniqueExecutionJob,
      update: prismaMocks.updateExecutionJob,
    },
  },
}));

vi.mock("@/server/repositories/browser-profile.repository", () => ({
  BrowserProfileRepository: { findByIdInProject: vi.fn() },
}));

const gatewayMocks = vi.hoisted(() => ({
  startAgentRun: vi.fn(),
  sendFollowUp: vi.fn(),
  getRunState: vi.fn(),
  listAgentIds: vi.fn(),
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
      listAgentIds: gatewayMocks.listAgentIds,
    },
  }),
);

import { OpenClawProvider } from "@/server/execution/providers/openclaw/openclaw-provider";
import { BrowserProfileRepository } from "@/server/repositories/browser-profile.repository";
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
    gatewayMocks.listAgentIds.mockResolvedValue(new Set());
    prismaMocks.findUniqueExecutionJob.mockResolvedValue(undefined);
    prismaMocks.updateExecutionJob.mockResolvedValue({});
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

    // TIKTOK_PUBLISH is deliberately absent from execution-policy.ts's
    // BROWSER_PURPOSE_BY_CAPABILITY map (it routes through TikTokApiProvider's
    // own OAuth credential instead, see that map's comment) so
    // requiresBrowserProfile() is false for it — unlike the research family
    // (WEB_RESEARCH, BRAND_DISCOVERY, SIGNAL_SCAN, etc.), which all map to
    // the PUBLIC_RESEARCH purpose and so DO require a profile (see the next
    // test) so their agent resolves to the project's own OpenClaw agent
    // rather than the shared default.
    it("allows a capability with no static browser-purpose mapping without a profile", async () => {
      const provider = new OpenClawProvider();
      expect(await provider.canExecute("TIKTOK_PUBLISH", context)).toBe(true);
    });

    // BRAND_DISCOVERY (and the rest of the research family) requires a
    // browser profile precisely so resolveAgentId() routes to the project's
    // own PUBLIC_RESEARCH agent instead of silently falling back to the
    // shared OPENCLAW_DEFAULT_AGENT_ID — see execution-policy.ts's
    // BROWSER_PURPOSE_BY_CAPABILITY comment for the incident this fixed.
    it("requires a browser profile for the research capability family", async () => {
      const provider = new OpenClawProvider();
      expect(await provider.canExecute("BRAND_DISCOVERY", context)).toBe(false);
      expect(
        await provider.canExecute("SIGNAL_SCAN", {
          ...context,
          browserProfileId: "profile-1",
        }),
      ).toBe(true);
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

  // Audit problem 13: the in-memory `store` Map (and OpenClawGatewayClient's
  // own `runStates` Map) are process-local — a Railway redeploy/crash
  // between execute() and the next getStatus() poll wipes them, and
  // getStatus() used to unconditionally report "Unknown OpenClaw execution
  // reference" even though the Gateway itself (a separate long-lived
  // process) still had the real run in progress or finished. execute() now
  // persists {agentId, sessionKey, runId} into ExecutionJob.rawResult so
  // getStatus() can re-attach to the Gateway run from Postgres.
  describe("durable execution state (process restart recovery)", () => {
    it("persists the {agentId, sessionKey, runId} triple to ExecutionJob.rawResult on execute()", async () => {
      gatewayMocks.startAgentRun.mockResolvedValue({ runId: "run-abc" });

      const provider = new OpenClawProvider();
      await provider.execute({
        executionJobId: "job-1",
        correlationId: "corr-1",
        idempotencyKey: "task-1:WEB_RESEARCH",
        capability: "WEB_RESEARCH",
        context,
        payload: {},
      });

      expect(prismaMocks.updateExecutionJob).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: {
          rawResult: {
            agentId: "hubconnect",
            sessionKey: "corr-1",
            runId: "run-abc",
          },
        },
      });
    });

    it("merges into any existing rawResult instead of overwriting it", async () => {
      prismaMocks.findUniqueExecutionJob.mockResolvedValue({
        rawResult: { keepMe: "already-there" },
      });
      gatewayMocks.startAgentRun.mockResolvedValue({ runId: "run-abc" });

      const provider = new OpenClawProvider();
      await provider.execute({
        executionJobId: "job-1",
        correlationId: "corr-1",
        idempotencyKey: "task-1:WEB_RESEARCH",
        capability: "WEB_RESEARCH",
        context,
        payload: {},
      });

      expect(prismaMocks.updateExecutionJob).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: {
          rawResult: {
            keepMe: "already-there",
            agentId: "hubconnect",
            sessionKey: "corr-1",
            runId: "run-abc",
          },
        },
      });
    });

    it("recovers the run reference from Postgres when the in-memory store has no entry (simulated process restart) and resumes normal Gateway polling", async () => {
      prismaMocks.findUniqueExecutionJob.mockResolvedValue({
        rawResult: {
          agentId: "hubconnect",
          sessionKey: "restart-corr",
          runId: "run-restart",
        },
      });
      gatewayMocks.getRunState.mockReturnValue({
        kind: "done",
        result: { ok: true, runId: "run-restart", finalText: "done" },
      });

      // A fresh provider instance changes nothing here — `store` is a
      // module-level singleton — but this is deliberately a correlationId
      // that this test never calls execute() with, so the in-memory Map is
      // guaranteed to miss exactly like it would after a real restart.
      const provider = new OpenClawProvider();
      const status = await provider.getStatus("restart-corr");

      expect(status.status).toBe("COMPLETED");
      expect(prismaMocks.findUniqueExecutionJob).toHaveBeenCalledWith({
        where: { correlationId: "restart-corr" },
        select: { rawResult: true },
      });
      expect(gatewayMocks.getRunState).toHaveBeenCalledWith(
        "run-restart",
        expect.any(Number),
      );
    });

    it("still returns FAILED for an unknown reference when neither the in-memory store nor Postgres has it", async () => {
      prismaMocks.findUniqueExecutionJob.mockResolvedValue(null);

      const provider = new OpenClawProvider();
      const status = await provider.getStatus("truly-never-executed");

      expect(status.status).toBe("FAILED");
      expect(status.errorMessage).toBe("Unknown OpenClaw execution reference");
      expect(gatewayMocks.getRunState).not.toHaveBeenCalled();
    });
  });

  describe("resolveAgentId", () => {
    it("uses the Gateway's agent list to validate a browser profile's candidate agent id", async () => {
      gatewayMocks.listAgentIds.mockResolvedValue(new Set(["project-slug-1"]));
      gatewayMocks.startAgentRun.mockResolvedValue({ runId: "run-abc" });
      vi.mocked(BrowserProfileRepository.findByIdInProject).mockResolvedValue({
        externalProfileId: null,
        slug: "project-slug-1",
      } as never);
      prismaMocks.findUniqueProject.mockResolvedValue({
        slug: "project-slug-1",
      });

      const provider = new OpenClawProvider();
      await provider.execute({
        executionJobId: "job-1",
        correlationId: "corr-1",
        idempotencyKey: "task-1:INSTAGRAM_PUBLISH",
        capability: "INSTAGRAM_PUBLISH",
        context: { ...context, browserProfileId: "profile-1" },
        payload: {},
      });

      expect(gatewayMocks.listAgentIds).toHaveBeenCalled();
      expect(gatewayMocks.startAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "project-slug-1" }),
      );
    });

    it("falls back to the default agent when the candidate isn't in the Gateway's list", async () => {
      gatewayMocks.listAgentIds.mockResolvedValue(
        new Set(["some-other-agent"]),
      );
      gatewayMocks.startAgentRun.mockResolvedValue({ runId: "run-abc" });
      vi.mocked(BrowserProfileRepository.findByIdInProject).mockResolvedValue({
        externalProfileId: null,
        slug: "project-slug-1",
      } as never);
      prismaMocks.findUniqueProject.mockResolvedValue({
        slug: "project-slug-1",
      });

      const provider = new OpenClawProvider();
      await provider.execute({
        executionJobId: "job-1",
        correlationId: "corr-1",
        idempotencyKey: "task-1:INSTAGRAM_PUBLISH",
        capability: "INSTAGRAM_PUBLISH",
        context: { ...context, browserProfileId: "profile-1" },
        payload: {},
      });

      expect(gatewayMocks.startAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "hubconnect" }),
      );
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
