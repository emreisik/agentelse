import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: "Check again" her recheckNow sonucunu doğru
// mesaja çevirir ve yalnız başarıda Website sayfasını tazeler; "Mute 7 days"
// uyarıyı 7 gün susturur; proje erişimi reddedilince iki eylem de
// {ok:false} döner ve hiçbir iş yapmaz.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  recheckNow: vi.fn(),
  mute: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/website-analytics/health/runner", () => ({
  GaHealth: { recheckNow: mocks.recheckNow },
}));
vi.mock("@/server/monitoring/site-alerts", () => ({
  SiteAlerts: { mute: mocks.mute },
}));

const { muteMeasurementAlertAction, recheckMeasurementHealthAction } =
  await import("./measurement-health-actions");

const form = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  data.set("projectId", "proj-1");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_HEALTH", "true");
  vi.stubEnv("GA_SYNC", "true");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ userId: "user-1" });
  mocks.requireProjectAccess.mockResolvedValue(undefined);
  mocks.mute.mockResolvedValue(undefined);
});

describe("recheckMeasurementHealthAction", () => {
  it("rechecks and revalidates the Website page", async () => {
    mocks.recheckNow.mockResolvedValue("rechecked");
    expect(await recheckMeasurementHealthAction(form())).toEqual({ ok: true });
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("user-1", "proj-1");
    expect(mocks.recheckNow).toHaveBeenCalledWith("proj-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/site");
  });

  it.each([
    ["throttled", "Checked a few minutes ago. Try again in a few minutes."],
    ["busy", "A check is already running. Try again in a moment."],
    ["failed", "The check could not finish. We'll retry automatically."],
    ["unavailable", "Google Analytics isn't connected for this project."],
  ])("maps %s to its message", async (result, message) => {
    mocks.recheckNow.mockResolvedValue(result);
    expect(await recheckMeasurementHealthAction(form())).toEqual({
      ok: false,
      message,
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns ok:false when project access is denied", async () => {
    mocks.requireProjectAccess.mockRejectedValue(new Error("Forbidden"));
    expect(await recheckMeasurementHealthAction(form())).toEqual({
      ok: false,
      message: "Forbidden",
    });
    expect(mocks.recheckNow).not.toHaveBeenCalled();
  });
});

describe("muteMeasurementAlertAction", () => {
  it("mutes the alert for 7 days", async () => {
    expect(
      await muteMeasurementAlertAction(form({ alertId: "alert-1" })),
    ).toEqual({ ok: true });
    expect(mocks.mute).toHaveBeenCalledWith("alert-1", "proj-1", 7, "GA4");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/site");
  });

  it("returns ok:false when project access is denied", async () => {
    mocks.requireProjectAccess.mockRejectedValue(new Error("Forbidden"));
    expect(
      await muteMeasurementAlertAction(form({ alertId: "alert-1" })),
    ).toEqual({ ok: false, message: "Forbidden" });
    expect(mocks.mute).not.toHaveBeenCalled();
  });

  it("does nothing while GA_HEALTH is off", async () => {
    vi.stubEnv("GA_HEALTH", "false");
    expect(
      await muteMeasurementAlertAction(form({ alertId: "alert-1" })),
    ).toEqual({
      ok: false,
      message: "Google Analytics isn't connected for this project.",
    });
    expect(mocks.mute).not.toHaveBeenCalled();
  });

  it("does nothing for a project outside the dev allow-list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user@db.example.com/app");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "other-project");
    expect(
      await muteMeasurementAlertAction(form({ alertId: "alert-1" })),
    ).toEqual({
      ok: false,
      message: "Google Analytics isn't connected for this project.",
    });
    expect(mocks.mute).not.toHaveBeenCalled();
  });

  it("rejects a missing alert id", async () => {
    expect(await muteMeasurementAlertAction(form())).toEqual({
      ok: false,
      message: "Alert not found.",
    });
    expect(mocks.mute).not.toHaveBeenCalled();
  });
});
