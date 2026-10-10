import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentelseError } from "@/server/security/errors";

// Bu dosyanın kanıtladığı (SC-F4 eylemleri): hepsi oturum ve proje erişimi
// ister; GSC_SYNC, SEO_INSIGHTS=on ya da izin listesi kapalıyken depoya hiç
// gidilmez; Accept / Dismiss / Mark done depo sonucunu doğru mesaja çevirir;
// gölge inceleme yalnız platform operatörüne açıktır; marka önerisi
// eylemleri P4 işlevlerini çağırır ve Search sayfasını tazeler. Hiçbiri
// fırlatmaz. Kardeş paketlerin modülleri taklit edilir.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  record: vi.fn(),
  sync: vi.fn(),
  userFacing: vi.fn(),
  active: vi.fn(),
  allowed: vi.fn(),
  operator: vi.fn(),
  decideFinding: vi.fn(),
  loop: vi.fn(),
  seoAllowed: vi.fn(),
  trackFindingDone: vi.fn(),
  reviewShadowFinding: vi.fn(),
  suggestBrandTerms: vi.fn(),
  acceptBrandTermSuggestion: vi.fn(),
  dismissBrandTermSuggestion: vi.fn(),
  // billing/budget-stop.ts: the daily-counter sentence unless the PLAN is what ran out.
  budgetMessage: vi.fn(async (_projectId: string, daily: string) => daily),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/lib/seo/flags", () => ({ GscFlags: { sync: mocks.sync } }));
vi.mock("@/lib/seo/insight-flags", () => ({
  SeoInsightFlags: { userFacing: mocks.userFacing, active: mocks.active },
  seoInsightsAllowedFor: mocks.allowed,
}));
vi.mock("@/server/security/operator", () => ({
  isPlatformOperator: mocks.operator,
}));
vi.mock("@/lib/seo/action-flags", () => ({
  SeoActionFlags: { loop: mocks.loop },
  seoActionsAllowedFor: mocks.seoAllowed,
}));
vi.mock("@/server/seo/actions/fix-this", () => ({
  trackFindingDone: mocks.trackFindingDone,
}));
vi.mock("@/server/seo/opportunities/findings-store", () => ({
  decideFinding: mocks.decideFinding,
  reviewShadowFinding: mocks.reviewShadowFinding,
}));
vi.mock("@/server/billing/budget-stop", () => ({
  budgetMessageForProject: mocks.budgetMessage,
}));
vi.mock("@/server/seo/opportunities/brand-suggest", () => ({
  suggestBrandTerms: mocks.suggestBrandTerms,
  acceptBrandTermSuggestion: mocks.acceptBrandTermSuggestion,
  dismissBrandTermSuggestion: mocks.dismissBrandTermSuggestion,
}));

const {
  acceptOpportunityAction,
  dismissOpportunityAction,
  markOpportunityDoneAction,
  reviewShadowFindingAction,
  suggestBrandTermsAction,
  acceptBrandTermSuggestionAction,
  dismissBrandTermSuggestionAction,
} = await import("./search-opportunity-actions");

const form = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  data.set("projectId", "proj-1");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const ALL: [string, () => Promise<unknown>][] = [
  ["accept", () => acceptOpportunityAction(form({ findingId: "f-1" }))],
  [
    "dismiss",
    () =>
      dismissOpportunityAction(
        form({ findingId: "f-1", reason: "not_relevant" }),
      ),
  ],
  ["done", () => markOpportunityDoneAction(form({ findingId: "f-1" }))],
  [
    "review",
    () =>
      reviewShadowFindingAction(form({ findingId: "f-1", verdict: "USEFUL" })),
  ],
  ["suggest", () => suggestBrandTermsAction(form())],
  ["addTerm", () => acceptBrandTermSuggestionAction(form({ term: "acme" }))],
  [
    "dismissTerm",
    () => dismissBrandTermSuggestionAction(form({ term: "acme" })),
  ],
];

const WORK = [
  "decideFinding",
  "reviewShadowFinding",
  "suggestBrandTerms",
  "acceptBrandTermSuggestion",
  "dismissBrandTermSuggestion",
] as const;

function expectNoWork() {
  for (const name of WORK) expect(mocks[name], name).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ userId: "user-1", email: null });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  // The surface's own daily-counter sentence unless a test says the PLAN ran out.
  mocks.budgetMessage.mockImplementation(async (_projectId, daily) => daily);
  mocks.sync.mockReturnValue(true);
  mocks.userFacing.mockReturnValue(true);
  mocks.active.mockReturnValue(true);
  mocks.allowed.mockReturnValue(true);
  mocks.operator.mockReturnValue(true);
  mocks.decideFinding.mockResolvedValue({ ok: true, status: "ACCEPTED" });
  mocks.reviewShadowFinding.mockResolvedValue(true);
  mocks.suggestBrandTerms.mockResolvedValue({
    ok: true,
    suggestions: [{ term: "acme", reason: "Your name", at: "2026-10-07" }],
  });
  mocks.acceptBrandTermSuggestion.mockResolvedValue({ ok: true });
  mocks.dismissBrandTermSuggestion.mockResolvedValue(true);
});

describe("access", () => {
  it.each(ALL)("%s rejects a signed-out visitor", async (_name, run) => {
    mocks.requireUser.mockRejectedValue(
      new AgentelseError("LOGIN_REQUIRED", "Authentication required"),
    );
    await expect(run()).resolves.toEqual({
      ok: false,
      message: "Please sign in again.",
    });
    expectNoWork();
  });

  it.each(ALL)("%s rejects a project without access", async (_name, run) => {
    // Hata metni (proje ve çalışma alanı kimliği) istemciye gitmez.
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError(
        "PERMISSION_DENIED",
        "User user-1 has no access to workspace ws-secret",
      ),
    );
    await expect(run()).resolves.toEqual({
      ok: false,
      message: "This project isn't available.",
    });
    expectNoWork();
  });

  it.each(ALL)("%s does nothing while GSC_SYNC is off", async (_name, run) => {
    mocks.sync.mockReturnValue(false);
    const result = (await run()) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Search opportunities aren't turned on.");
    expectNoWork();
  });

  it.each(ALL)(
    "%s does nothing outside the rollout list",
    async (_name, run) => {
      mocks.allowed.mockReturnValue(false);
      const result = (await run()) as { ok: boolean; message: string };
      expect(result).toEqual({
        ok: false,
        message: "Search opportunities aren't set up for this project here.",
      });
      expect(mocks.allowed).toHaveBeenCalledWith("proj-1");
      expectNoWork();
    },
  );

  it("user actions need SEO_INSIGHTS=on (shadow is not enough)", async () => {
    mocks.userFacing.mockReturnValue(false);
    for (const [name, run] of ALL) {
      if (name === "review") continue;
      const result = (await run()) as { ok: boolean; message: string };
      expect(result.ok, name).toBe(false);
    }
    expectNoWork();
  });
});

describe("opportunity decisions", () => {
  it("accepts an opportunity and refreshes the Search page", async () => {
    await expect(
      acceptOpportunityAction(form({ findingId: "f-1" })),
    ).resolves.toEqual({ ok: true, message: "Accepted" });
    expect(mocks.decideFinding).toHaveBeenCalledWith({
      projectId: "proj-1",
      findingId: "f-1",
      decision: "ACCEPT",
      userId: "user-1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");
  });

  it("dismisses with a reason and marks done", async () => {
    await expect(
      dismissOpportunityAction(form({ findingId: "f-1", reason: "not_now" })),
    ).resolves.toEqual({ ok: true, message: "Dismissed" });
    expect(mocks.decideFinding).toHaveBeenLastCalledWith({
      projectId: "proj-1",
      findingId: "f-1",
      decision: "DISMISS",
      reason: "not_now",
      userId: "user-1",
    });
    await expect(
      markOpportunityDoneAction(form({ findingId: "f-1" })),
    ).resolves.toEqual({ ok: true, message: "Marked as done" });
    expect(mocks.decideFinding).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: "DONE" }),
    );
  });

  it("starts measurement on Done only with the action loop on and the project allowed (SC-F6)", async () => {
    await markOpportunityDoneAction(form({ findingId: "f-1" }));
    expect(mocks.trackFindingDone).not.toHaveBeenCalled();

    mocks.loop.mockReturnValue(true);
    mocks.seoAllowed.mockReturnValue(false);
    await markOpportunityDoneAction(form({ findingId: "f-1" }));
    expect(mocks.trackFindingDone).not.toHaveBeenCalled();

    mocks.seoAllowed.mockReturnValue(true);
    await acceptOpportunityAction(form({ findingId: "f-1" }));
    expect(mocks.trackFindingDone).not.toHaveBeenCalled();
    await markOpportunityDoneAction(form({ findingId: "f-1" }));
    expect(mocks.trackFindingDone).toHaveBeenCalledWith({
      projectId: "proj-1",
      findingId: "f-1",
      userId: "user-1",
      workspaceId: "ws-1",
    });

    // Ölçüm hatası Done kararını bozmaz.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.trackFindingDone.mockRejectedValue(new Error("db"));
    await expect(
      markOpportunityDoneAction(form({ findingId: "f-1" })),
    ).resolves.toEqual({ ok: true, message: "Marked as done" });
  });

  it("says the opportunity is no longer open when the store refuses", async () => {
    for (const reason of ["not_found", "invalid_transition", "shadow"]) {
      mocks.decideFinding.mockResolvedValueOnce({ ok: false, reason });
      await expect(
        acceptOpportunityAction(form({ findingId: "f-1" })),
      ).resolves.toEqual({
        ok: false,
        message: "This opportunity is no longer open.",
      });
    }
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a missing id or an unknown dismiss reason without a store call", async () => {
    expect((await acceptOpportunityAction(form())).ok).toBe(false);
    expect(
      (
        await dismissOpportunityAction(
          form({ findingId: "f-1", reason: "spam" }),
        )
      ).ok,
    ).toBe(false);
    expect(mocks.decideFinding).not.toHaveBeenCalled();
  });

  it("never throws when the store fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.decideFinding.mockRejectedValue(new Error("db down"));
    await expect(
      markOpportunityDoneAction(form({ findingId: "f-1" })),
    ).resolves.toEqual({
      ok: false,
      message: "The opportunity could not be updated",
    });
  });
});

describe("shadow review", () => {
  it("requires a platform operator", async () => {
    mocks.operator.mockReturnValue(false);
    await expect(
      reviewShadowFindingAction(form({ findingId: "f-1", verdict: "USEFUL" })),
    ).resolves.toEqual({
      ok: false,
      message: "Only platform operators can review shadow findings.",
    });
    expect(mocks.operator).toHaveBeenCalledWith("user-1");
    expectNoWork();
  });

  it("works in shadow mode and saves the verdict", async () => {
    mocks.userFacing.mockReturnValue(false);
    await expect(
      reviewShadowFindingAction(
        form({ findingId: "f-1", verdict: "NOT_USEFUL" }),
      ),
    ).resolves.toEqual({ ok: true, message: "Thanks for the review" });
    expect(mocks.reviewShadowFinding).toHaveBeenCalledWith({
      projectId: "proj-1",
      findingId: "f-1",
      verdict: "NOT_USEFUL",
      userId: "user-1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");
  });

  it("needs the engine to be active and a valid verdict", async () => {
    await expect(
      reviewShadowFindingAction(form({ findingId: "f-1", verdict: "MAYBE" })),
    ).resolves.toMatchObject({ ok: false });
    mocks.active.mockReturnValue(false);
    await expect(
      reviewShadowFindingAction(form({ findingId: "f-1", verdict: "USEFUL" })),
    ).resolves.toMatchObject({ ok: false });
    expect(mocks.reviewShadowFinding).not.toHaveBeenCalled();
  });
});

describe("brand-term suggestions", () => {
  it("asks for suggestions and records only their count", async () => {
    await expect(suggestBrandTermsAction(form())).resolves.toEqual({
      ok: true,
      message: "Looking at your searches for brand terms…",
    });
    expect(mocks.suggestBrandTerms).toHaveBeenCalledWith("proj-1");
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "search_console.brand_terms_suggested",
        entityType: "GscSiteLink",
        metadata: { count: 1 },
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");
  });

  it("explains why suggesting did not run", async () => {
    mocks.suggestBrandTerms.mockResolvedValue({ ok: false, reason: "budget" });
    const result = await suggestBrandTermsAction(form());
    expect(result).toEqual({
      ok: false,
      message: "The AI budget for today is used up. Try again tomorrow.",
    });
    expect(result.ok).toBe(false);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("says the plan's usage is what ran out when it is (not 'try again tomorrow')", async () => {
    mocks.suggestBrandTerms.mockResolvedValue({ ok: false, reason: "budget" });
    mocks.budgetMessage.mockResolvedValueOnce(
      "Your plan's AI usage for this period is used up; it renews on Nov 1.",
    );

    const result = await suggestBrandTermsAction(form());

    expect(result).toEqual({
      ok: false,
      message: "Your plan's AI usage for this period is used up; it renews on Nov 1.",
    });
    expect(mocks.budgetMessage).toHaveBeenCalledWith(
      "proj-1",
      "The AI budget for today is used up. Try again tomorrow.",
    );
  });

  it("adds a suggested term through P4 with the acting user", async () => {
    await expect(
      acceptBrandTermSuggestionAction(form({ term: " acme " })),
    ).resolves.toEqual({
      ok: true,
      message:
        "Brand term added. Brand and non-brand clicks update with the next sync.",
    });
    expect(mocks.acceptBrandTermSuggestion).toHaveBeenCalledWith({
      projectId: "proj-1",
      term: "acme",
      userId: "user-1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");

    mocks.acceptBrandTermSuggestion.mockResolvedValue({
      ok: false,
      reason: "not_suggested",
    });
    await expect(
      acceptBrandTermSuggestionAction(form({ term: "acme" })),
    ).resolves.toEqual({
      ok: false,
      message: "This suggestion is no longer available.",
    });
  });

  it("dismisses a suggested term", async () => {
    await expect(
      dismissBrandTermSuggestionAction(form({ term: "acme" })),
    ).resolves.toEqual({ ok: true, message: "Dismissed" });
    expect(mocks.dismissBrandTermSuggestion).toHaveBeenCalledWith({
      projectId: "proj-1",
      term: "acme",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");
  });

  it("rejects an empty term without a call", async () => {
    expect((await acceptBrandTermSuggestionAction(form())).ok).toBe(false);
    expect((await dismissBrandTermSuggestionAction(form())).ok).toBe(false);
    expect(mocks.acceptBrandTermSuggestion).not.toHaveBeenCalled();
    expect(mocks.dismissBrandTermSuggestion).not.toHaveBeenCalled();
  });
});
