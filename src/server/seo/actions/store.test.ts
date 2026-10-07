import { Prisma, type SeoAction } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  actionViewFixture,
  proposalFixture,
} from "@/lib/seo/actions/test-support";
import type { SeoActionView } from "@/lib/seo/actions/types";
import { seoMockMode } from "@/lib/seo/health-flags";

// Bu dosyanın kanıtladığı: createSeoAction yarışta (P2002) açık satırı döner,
// açık bağ ancak aynı kipin birincil bağından çözülür ve açık bağ (null dahil)
// kazanır; makalesi takvimde olan kabul edilmiş eylem nextCheckAt alır; CAS
// kaçırınca invalid_transition döner; APPLY doğrulamayı sıfırlar ve bulguyu DONE
// yapar, UNDO_APPLY geri alır, DISMISS openKey'i boşaltır; CONFIRM_LIVE ölçümü
// appliedAt çapasıyla başlatır; startMeasuring bağı geç bağlar (SEO kaynaklı
// uyarı eylemlerinde asla) ve bulgunun vadesini uzatır; attachCreative türü
// değiştirmeden PROPOSED'ı ACCEPTED yapar; denetim kaydında URL/başlık yoktur.

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  findingUpdateMany: vi.fn(),
  primaryGscLink: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoAction: {
      create: mocks.create,
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
    },
    seoFinding: { updateMany: mocks.findingUpdateMany },
  },
}));
vi.mock("@/server/seo/store", () => ({
  primaryGscLink: mocks.primaryGscLink,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));

import {
  attachCreative,
  createSeoAction,
  startMeasuring,
  transitionAction,
} from "./store";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 86_400_000;

function rowOf(view: SeoActionView, extra: Partial<SeoAction> = {}): SeoAction {
  return {
    id: view.id,
    workspaceId: view.workspaceId,
    projectId: view.projectId,
    isMock: seoMockMode(),
    linkId: view.linkId,
    findingId: view.findingId,
    source: view.source,
    kind: view.kind,
    openKey: null,
    pageId: view.pageId,
    targetUrl: view.targetUrl,
    targetUrlHash: view.targetUrlHash,
    targetQueries: view.targetQueries,
    proposal: view.proposal as unknown as Prisma.JsonValue,
    baseline: null,
    status: view.status,
    appliedVia: view.appliedVia,
    appliedAt: view.appliedAt,
    appliedByUserId: null,
    verifiedAt: view.verifiedAt,
    verification: view.verification as unknown as Prisma.JsonValue,
    verifyAttempts: 0,
    askedAt: view.askedAt,
    nextCheckAt: view.nextCheckAt,
    leaseUntil: null,
    leaseOwner: null,
    windowDays: view.windowDays,
    measureFrom: view.measureFrom,
    evaluateAfter: view.evaluateAfter,
    evaluatedAt: null,
    evaluation: null,
    outcome: null,
    confidence: null,
    learningId: null,
    creativeId: view.creativeId,
    commandId: view.commandId,
    workId: view.workId,
    approvalId: null,
    createdByUserId: null,
    decidedAt: null,
    dismissReason: null,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    ...extra,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "workspace-1",
    projectId: "project-1",
    kind: "TITLE_META" as const,
    source: "FINDING" as const,
    status: "PROPOSED" as const,
    openKey: "finding:f1",
    targetUrl: "https://example.com/page",
    pageId: null,
    targetQueries: [],
    proposal: proposalFixture("TITLE_META"),
    userId: "user-1",
    now: NOW,
    ...overrides,
  };
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("duplicate", {
    code: "P2002",
    clientVersion: "test",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.findingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.audit.mockResolvedValue({});
});

describe("createSeoAction", () => {
  it("returns the existing open row when the open key is taken (P2002)", async () => {
    const existing = rowOf(actionViewFixture({ status: "ACCEPTED" }));
    mocks.create.mockRejectedValue(uniqueViolation());
    mocks.findFirst.mockResolvedValue(existing);
    mocks.primaryGscLink.mockResolvedValue(null);
    const result = await createSeoAction(baseInput());
    expect(result.created).toBe(false);
    expect(result.action.id).toBe(existing.id);
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        isMock: seoMockMode(),
        openKey: "finding:f1",
      },
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("lets an explicit linkId win and resolves an undefined one from the same-mode primary link", async () => {
    mocks.create.mockImplementation(async ({ data }) =>
      rowOf(actionViewFixture({ linkId: data.linkId, status: "PROPOSED" })),
    );
    mocks.primaryGscLink.mockResolvedValue({
      id: "primary",
      isMock: seoMockMode(),
    });

    await createSeoAction(baseInput({ linkId: "finding-link" }));
    expect(mocks.create.mock.calls[0]![0].data.linkId).toBe("finding-link");
    expect(mocks.primaryGscLink).not.toHaveBeenCalled();

    await createSeoAction(baseInput({ linkId: null, openKey: "finding:f2" }));
    expect(mocks.create.mock.calls[1]![0].data.linkId).toBeNull();

    await createSeoAction(baseInput({ openKey: "finding:f3" }));
    expect(mocks.create.mock.calls[2]![0].data.linkId).toBe("primary");

    mocks.primaryGscLink.mockResolvedValue({
      id: "other-mode",
      isMock: !seoMockMode(),
    });
    await createSeoAction(baseInput({ openKey: "finding:f4" }));
    expect(mocks.create.mock.calls[3]![0].data.linkId).toBeNull();
  });

  it("schedules an accepted article with a creative for the next check", async () => {
    mocks.create.mockImplementation(async ({ data }) =>
      rowOf(actionViewFixture({ kind: "NEW_CONTENT", status: "ACCEPTED" }), {
        nextCheckAt: data.nextCheckAt,
      }),
    );
    const result = await createSeoAction(
      baseInput({
        kind: "NEW_CONTENT",
        proposal: proposalFixture("NEW_CONTENT"),
        status: "ACCEPTED",
        creativeId: "creative-1",
        linkId: null,
        openKey: "card:c1",
      }),
    );
    expect(mocks.create.mock.calls[0]![0].data.nextCheckAt).toEqual(NOW);
    expect(result.action.nextCheckAt).toEqual(NOW);
  });

  it("marks the finding done when it is created applied, and audits only kind, source and status", async () => {
    mocks.create.mockImplementation(async () =>
      rowOf(
        actionViewFixture({
          status: "APPLIED",
          findingId: "finding-1",
          targetUrl: "https://example.com/secret-path",
        }),
      ),
    );
    await createSeoAction(
      baseInput({ status: "APPLIED", findingId: "finding-1", linkId: null }),
    );
    expect(mocks.findingUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.findingUpdateMany.mock.calls[0]![0].where.status).toEqual({
      in: ["OPEN", "ACCEPTED"],
    });
    expect(mocks.findingUpdateMany.mock.calls[0]![0].data.status).toBe("DONE");
    const audit = mocks.audit.mock.calls[0]![0];
    expect(audit.action).toBe("seo_action.created");
    expect(Object.keys(audit.metadata).sort()).toEqual([
      "kind",
      "source",
      "status",
    ]);
    expect(JSON.stringify(audit)).not.toContain("secret-path");
  });
});

describe("transitionAction", () => {
  function current(
    status: SeoActionView["status"],
    overrides: Partial<SeoActionView> = {},
  ) {
    mocks.findFirst.mockResolvedValue(
      rowOf(actionViewFixture({ status, ...overrides })),
    );
  }

  it("reports a lost CAS as invalid_transition", async () => {
    current("PROPOSED");
    mocks.updateMany.mockResolvedValue({ count: 0 });
    const result = await transitionAction({
      projectId: "project-1",
      actionId: "action-1",
      event: "ACCEPT",
      userId: "user-1",
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("reports an impossible event and a missing row", async () => {
    current("EVALUATING");
    expect(
      await transitionAction({
        projectId: "project-1",
        actionId: "action-1",
        event: "APPLY",
        userId: "user-1",
      }),
    ).toEqual({ ok: false, reason: "invalid_transition" });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    mocks.findFirst.mockResolvedValue(null);
    expect(
      await transitionAction({
        projectId: "project-1",
        actionId: "gone",
        event: "ACCEPT",
        userId: "user-1",
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("applies: resets the verification, sets the check time and marks the finding done", async () => {
    current("ACCEPTED", { findingId: "finding-1" });
    await transitionAction({
      projectId: "project-1",
      actionId: "action-1",
      event: "APPLY",
      userId: "user-1",
      patch: { targetUrl: "https://example.com/new-path" },
      now: NOW,
    });
    const call = mocks.updateMany.mock.calls[0]![0];
    expect(call.where).toMatchObject({ status: "ACCEPTED" });
    expect(call.data).toMatchObject({
      status: "APPLIED",
      appliedAt: NOW,
      appliedVia: "USER",
      appliedByUserId: "user-1",
      verifyAttempts: 0,
      askedAt: null,
      nextCheckAt: NOW,
    });
    expect(call.data.verification.attempts).toBe(0);
    expect(call.data.targetUrl).toBe("https://example.com/new-path");
    expect(call.data.targetUrlHash).toEqual(expect.any(String));
    expect(mocks.findingUpdateMany.mock.calls[0]![0].data).toMatchObject({
      status: "DONE",
      decidedByUserId: "user-1",
    });
  });

  it("undoes an apply and reverts the finding", async () => {
    current("APPLIED", { findingId: "finding-1" });
    const result = await transitionAction({
      projectId: "project-1",
      actionId: "action-1",
      event: "UNDO_APPLY",
      userId: "user-1",
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(mocks.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: "ACCEPTED",
      appliedAt: null,
      nextCheckAt: null,
      askedAt: null,
    });
    const revert = mocks.findingUpdateMany.mock.calls[0]![0];
    expect(revert.where).toMatchObject({ status: "DONE", evaluatedAt: null });
    expect(revert.data).toEqual({ status: "ACCEPTED", evaluateAfter: null });
  });

  it("keeps a calendar article watched after an undo", async () => {
    current("APPLIED", { kind: "NEW_CONTENT", creativeId: "creative-1" });
    await transitionAction({
      projectId: "project-1",
      actionId: "action-1",
      event: "UNDO_APPLY",
      userId: "user-1",
      now: NOW,
    });
    expect(mocks.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: "ACCEPTED",
      nextCheckAt: NOW,
    });
  });

  it("never writes a user transition while the verifier holds the lease", async () => {
    current("APPLIED");
    await transitionAction({
      projectId: "project-1",
      actionId: "action-1",
      event: "UNDO_APPLY",
      userId: "user-1",
      now: NOW,
    });
    expect(mocks.updateMany.mock.calls[0]![0].where).toMatchObject({
      status: "APPLIED",
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: NOW } }],
    });
  });

  it("dismisses and frees the open key", async () => {
    current("PROPOSED");
    await transitionAction({
      projectId: "project-1",
      actionId: "action-1",
      event: "DISMISS",
      userId: "user-1",
      patch: { dismissReason: "not_relevant" },
      now: NOW,
    });
    expect(mocks.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: "DISMISSED",
      openKey: null,
      dismissReason: "not_relevant",
    });
    expect(mocks.audit.mock.calls[0]![0].action).toBe("seo_action.dismiss");
  });

  it("starts measuring from appliedAt when the user confirms it is live", async () => {
    const appliedAt = new Date(NOW.getTime() - 3 * DAY);
    current("APPLIED", { appliedAt, kind: "CONTENT_REFRESH" });
    mocks.primaryGscLink.mockResolvedValue(null);
    await transitionAction({
      projectId: "project-1",
      actionId: "action-1",
      event: "CONFIRM_LIVE",
      userId: "user-1",
      now: NOW,
    });
    const data = mocks.updateMany.mock.calls[0]![0].data;
    expect(data.status).toBe("EVALUATING");
    expect(data.measureFrom).toEqual(appliedAt);
    expect(data.evaluateAfter).toEqual(
      new Date(appliedAt.getTime() + 56 * DAY),
    );
    expect(data.verification.method).toBe("USER");
    expect(data.verification.google.state).toBe("skipped");
    expect(mocks.audit.mock.calls[0]![0].action).toBe(
      "seo_action.confirm_live",
    );
  });
});

describe("startMeasuring", () => {
  const verification = actionViewFixture().verification;

  it("binds a missing link late and extends the finding's evaluation date", async () => {
    mocks.primaryGscLink.mockResolvedValue({
      id: "late-link",
      isMock: seoMockMode(),
    });
    const action = actionViewFixture({
      linkId: null,
      findingId: "finding-1",
      kind: "TITLE_META",
    });
    const ok = await startMeasuring({
      action,
      owner: null,
      verifiedAt: NOW,
      method: "CRAWLER",
      verification,
      googleCrawlAt: null,
      now: NOW,
    });
    expect(ok).toBe(true);
    const data = mocks.updateMany.mock.calls[0]![0].data;
    expect(data.linkId).toBe("late-link");
    const finding = mocks.findingUpdateMany.mock.calls[0]![0];
    expect(finding.where).toMatchObject({ id: "finding-1", status: "DONE" });
    expect(finding.data.evaluateAfter).toEqual(
      new Date(data.evaluateAfter.getTime() + 21 * DAY),
    );
  });

  it("never binds a link to an SEO-sourced alert action", async () => {
    mocks.primaryGscLink.mockResolvedValue({
      id: "late-link",
      isMock: seoMockMode(),
    });
    const action = actionViewFixture({
      linkId: null,
      kind: "TECH_FIX",
      proposal: {
        ...proposalFixture("TECH_FIX"),
        alert: { kind: "SEO_KEY_PAGE_NOINDEX", dedupeKey: "k", source: "SEO" },
      },
    });
    await startMeasuring({
      action,
      owner: null,
      verifiedAt: NOW,
      method: "ALERT",
      verification,
      googleCrawlAt: null,
      now: NOW,
    });
    expect(mocks.primaryGscLink).not.toHaveBeenCalled();
    expect(mocks.updateMany.mock.calls[0]![0].data.linkId).toBeUndefined();
  });

  it("refuses an action that cannot start measuring and reports a lost CAS", async () => {
    expect(
      await startMeasuring({
        action: actionViewFixture({ status: "ACCEPTED" }),
        owner: null,
        verifiedAt: NOW,
        method: "CRAWLER",
        verification,
        googleCrawlAt: null,
        now: NOW,
      }),
    ).toBe(false);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    mocks.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await startMeasuring({
        action: actionViewFixture({ linkId: "link-1" }),
        owner: null,
        verifiedAt: NOW,
        method: "CRAWLER",
        verification,
        googleCrawlAt: null,
        now: NOW,
      }),
    ).toBe(false);
    expect(mocks.findingUpdateMany).not.toHaveBeenCalled();
  });

  it("writes through the lease when an owner is given", async () => {
    await startMeasuring({
      action: actionViewFixture({ linkId: "link-1" }),
      owner: "verify:abc",
      verifiedAt: NOW,
      method: "CRAWLER",
      verification,
      googleCrawlAt: null,
      now: NOW,
    });
    const call = mocks.updateMany.mock.calls[0]![0];
    expect(call.where).toEqual({
      id: "action-1",
      leaseOwner: "verify:abc",
      status: "APPLIED",
    });
    expect(call.data).toMatchObject({
      status: "EVALUATING",
      leaseOwner: null,
      leaseUntil: null,
    });
  });
});

describe("attachCreative", () => {
  it("moves PROPOSED to ACCEPTED, keeps the kind and only touches open actions", async () => {
    const next = new Date(NOW.getTime() + DAY);
    const ok = await attachCreative({
      projectId: "project-1",
      actionId: "action-1",
      creativeId: "creative-1",
      nextCheckAt: next,
    });
    expect(ok).toBe(true);
    const call = mocks.updateMany.mock.calls[0]![0];
    expect(call.where.status).toEqual({ in: ["PROPOSED", "ACCEPTED"] });
    expect(call.data).toEqual({
      status: "ACCEPTED",
      creativeId: "creative-1",
      nextCheckAt: next,
    });
    mocks.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await attachCreative({
        projectId: "project-1",
        actionId: "action-1",
        creativeId: "creative-1",
        nextCheckAt: next,
      }),
    ).toBe(false);
  });
});
