import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentelseError } from "@/server/security/errors";

// Bu dosyanın kanıtladığı: Insights eylemleri girişi doğrular, oturum ve
// proje erişimini ister, GaFindingActions sonucunu doğru mesaja çevirir ve
// yalnız başarıda Website sayfasını tazeler; inceleme platform operatörü
// olmayana kapalıdır.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isPlatformOperator: vi.fn(),
  accept: vi.fn(),
  dismiss: vi.fn(),
  markDone: vi.fn(),
  review: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/security/operator", () => ({
  isPlatformOperator: mocks.isPlatformOperator,
}));
vi.mock("@/server/website-analytics/analysis/lifecycle", () => ({
  GaFindingActions: {
    accept: mocks.accept,
    dismiss: mocks.dismiss,
    markDone: mocks.markDone,
    review: mocks.review,
  },
}));

const {
  acceptGaFindingAction,
  dismissGaFindingAction,
  markGaFindingDoneAction,
  reviewGaFindingAction,
} = await import("./website-insights-actions");

const form = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  data.set("projectId", "proj-1");
  data.set("findingId", "f-1");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const INVALID = "Something is missing. Reload the page and try again.";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ userId: "user-1" });
  mocks.requireProjectAccess.mockResolvedValue(undefined);
  mocks.isPlatformOperator.mockReturnValue(true);
  for (const name of ["accept", "dismiss", "markDone", "review"] as const) {
    mocks[name].mockResolvedValue("ok");
  }
});

const cases = [
  ["accept", acceptGaFindingAction, mocks.accept],
  ["dismiss", dismissGaFindingAction, mocks.dismiss],
  ["markDone", markGaFindingDoneAction, mocks.markDone],
] as const;

describe.each(cases)("%s action", (_name, action, call) => {
  it("runs and revalidates the Website page", async () => {
    expect(await action(form())).toEqual({ ok: true });
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("user-1", "proj-1");
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        findingId: "f-1",
        userId: "user-1",
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/site");
  });

  it.each([
    ["not_found", "This finding no longer exists."],
    ["invalid", "This finding has already changed. Refresh the page."],
    ["off", "Website insights are turned off."],
  ])("maps %s to its message", async (result, message) => {
    call.mockResolvedValue(result);
    expect(await action(form())).toEqual({ ok: false, message });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a missing finding id before any lookup", async () => {
    const data = new FormData();
    data.set("projectId", "proj-1");
    expect(await action(data)).toEqual({ ok: false, message: INVALID });
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("returns ok:false when project access is denied", async () => {
    // Hata metni (proje ve çalışma alanı kimliği) istemciye gitmez.
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project proj-9 not found"),
    );
    expect(await action(form())).toEqual({
      ok: false,
      message: "This project isn't available.",
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("hides internal error text behind the fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    call.mockRejectedValue(new Error("db detail"));
    const result = (await action(form())) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("db detail");
  });
});

describe("reviewGaFindingAction", () => {
  it("records the verdict for the operator", async () => {
    expect(
      await reviewGaFindingAction(form({ verdict: "NOT_USEFUL" })),
    ).toEqual({ ok: true });
    expect(mocks.isPlatformOperator).toHaveBeenCalledWith("user-1");
    expect(mocks.review).toHaveBeenCalledWith({
      projectId: "proj-1",
      findingId: "f-1",
      userId: "user-1",
      verdict: "NOT_USEFUL",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/site");
  });

  it("refuses a non-operator", async () => {
    mocks.isPlatformOperator.mockReturnValue(false);
    expect(await reviewGaFindingAction(form({ verdict: "USEFUL" }))).toEqual({
      ok: false,
      message: "Only the platform operator can review findings.",
    });
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects an unknown verdict", async () => {
    expect(await reviewGaFindingAction(form({ verdict: "MAYBE" }))).toEqual({
      ok: false,
      message: INVALID,
    });
    expect(await reviewGaFindingAction(form())).toEqual({
      ok: false,
      message: INVALID,
    });
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("maps a stale finding to its message", async () => {
    mocks.review.mockResolvedValue("invalid");
    expect(await reviewGaFindingAction(form({ verdict: "USEFUL" }))).toEqual({
      ok: false,
      message: "This finding has already changed. Refresh the page.",
    });
  });

  it("returns ok:false when project access is denied", async () => {
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("PERMISSION_DENIED", "User user-1 has no access"),
    );
    expect(await reviewGaFindingAction(form({ verdict: "USEFUL" }))).toEqual({
      ok: false,
      message: "This project isn't available.",
    });
    expect(mocks.review).not.toHaveBeenCalled();
  });
});
