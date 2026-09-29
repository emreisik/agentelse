import { beforeEach, describe, expect, it, vi } from "vitest";

// start_deep_enrichment: the optional deep brand research the client can ask
// for. It runs for a long time and costs research budget, and it writes to the
// brand, so what matters is that the model cannot aim it at anything but this
// project's own brand, that it starts at most once, and that the reply never
// claims it is finished.

const prismaMock = vi.hoisted(() => ({
  projectSetupState: { findUnique: vi.fn() },
  project: { findUnique: vi.fn() },
  brand: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets: vi.fn(),
}));
vi.mock("@/server/brand-twin/brand-twin", () => ({ getBrandTwin: vi.fn() }));
vi.mock("@/server/brand-twin/brand-twin-writes", () => ({
  recordUserDecision: vi.fn(),
}));
const startAgencySetupForProject = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/agency-setup-actions", () => ({
  startAgencySetupForProject,
}));
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit: vi.fn() },
}));

const { toolsForPhase } = await import("./tools");

const tool = (phase: "ACTIVE" | "ON_HOLD" = "ACTIVE") =>
  toolsForPhase(phase).find((candidate) => candidate.name === "start_deep_enrichment");

const ctx = {
  workspaceId: "ws-1",
  projectId: "proj-1",
  brandId: "brand-1",
  userId: "user-1",
  commandId: "cmd-1",
  message: "yes, do the deep research",
  phase: "ACTIVE" as const,
  emit: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  prismaMock.projectSetupState.findUnique.mockResolvedValue(null);
  prismaMock.project.findUnique.mockResolvedValue({
    name: "Acme Proje",
    domain: " acme.com.tr ",
  });
  prismaMock.brand.findUnique.mockResolvedValue({ name: "Acme Boya" });
  startAgencySetupForProject.mockResolvedValue({ ok: true });
});

describe("start_deep_enrichment", () => {
  it("is offered on an active project and never on one that is on hold", () => {
    expect(tool("ACTIVE")).toBeDefined();
    expect(tool("ON_HOLD")).toBeUndefined();
  });

  it("counts as the turn's one work action", () => {
    expect(tool()!.kind).toBe("work");
  });

  it("starts an ENRICHMENT for the project's own brand, read from the database", async () => {
    const outcome = await tool()!.execute(
      { focus: " rakip analizi ", autoApprove: true },
      ctx,
    );

    expect(startAgencySetupForProject).toHaveBeenCalledWith({
      projectId: "proj-1",
      workspaceId: "ws-1",
      brandId: "brand-1",
      userId: "user-1",
      brandName: "Acme Boya",
      domain: "acme.com.tr",
      description: "rakip analizi",
      autoApprove: true,
      mode: "ENRICHMENT",
    });
    // ANSWERED, not PLANNED: no Task exists, so no "Task created" badge.
    expect(outcome.status).toBe("ANSWERED");
    expect(outcome.result).toMatchObject({ outcome: "enrichment_started" });
    expect(JSON.stringify(outcome.result)).toContain("Never say it is finished");
  });

  it("leaves the goals waiting for the client unless they asked to approve them automatically", async () => {
    await tool()!.execute({}, ctx);

    expect(startAgencySetupForProject).toHaveBeenCalledWith(
      expect.objectContaining({
        autoApprove: undefined,
        description: undefined,
        mode: "ENRICHMENT",
      }),
    );
  });

  it("does not let the model name the brand or the website", () => {
    const parsed = tool()!.schema.parse({
      focus: "x",
      brandName: "Someone Else",
      domain: "evil.example",
    });

    expect(parsed).toEqual({ focus: "x" });
  });

  it("falls back to the project's name when the brand has none", async () => {
    prismaMock.brand.findUnique.mockResolvedValue({ name: "  " });

    await tool()!.execute({}, ctx);

    expect(startAgencySetupForProject).toHaveBeenCalledWith(
      expect.objectContaining({ brandName: "Acme Proje" }),
    );
  });

  it("starts without a website when the project has none", async () => {
    prismaMock.project.findUnique.mockResolvedValue({
      name: "Acme Proje",
      domain: null,
    });

    await tool()!.execute({}, ctx);

    expect(startAgencySetupForProject.mock.calls[0]![0].domain).toBeUndefined();
  });

  it("does not start a second research while one is running", async () => {
    prismaMock.projectSetupState.findUnique.mockResolvedValue({
      activatedAt: null,
    });

    const outcome = await tool()!.execute({}, ctx);

    expect(startAgencySetupForProject).not.toHaveBeenCalled();
    expect(outcome.result).toMatchObject({
      outcome: "enrichment_already_running",
    });
  });

  it("says it already ran, rather than starting again, when it has finished", async () => {
    prismaMock.projectSetupState.findUnique.mockResolvedValue({
      activatedAt: new Date(),
    });

    const outcome = await tool()!.execute({}, ctx);

    expect(startAgencySetupForProject).not.toHaveBeenCalled();
    expect(outcome.result).toMatchObject({ outcome: "enrichment_already_done" });
  });

  it("refuses to start with no brand name to research", async () => {
    prismaMock.brand.findUnique.mockResolvedValue(null);
    prismaMock.project.findUnique.mockResolvedValue({ name: "", domain: null });

    const outcome = await tool()!.execute({}, ctx);

    expect(startAgencySetupForProject).not.toHaveBeenCalled();
    expect(outcome.result).toMatchObject({ outcome: "missing_brand_name" });
  });

  it("reports a failed start honestly", async () => {
    startAgencySetupForProject.mockResolvedValue({
      ok: false,
      message: "db down",
    });

    const outcome = await tool()!.execute({}, ctx);

    expect(outcome.status).toBe("ERROR");
    expect(outcome.result).toMatchObject({ outcome: "enrichment_failed" });
  });
});
