import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: yönetici olmayan reddedilir; GA_AGENCY kapalıyken ve
// geliştirme izin listesi dışındaki projede ret (yazma yok); başarıda site yolu
// yeniden doğrulanır ve işlev yöneticinin kimliğiyle çağrılır (denetim kaydını
// properties.ts yazar); iş sonucu kullanıcı metnine çevrilir; hata metni sızmaz.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  makeMain: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/server/website-analytics/agency/properties", () => ({
  addExtraGaProperty: mocks.add,
  removeExtraGaProperty: mocks.remove,
  makeGaPropertyMain: mocks.makeMain,
}));

const { addGaPropertyAction, removeGaPropertyAction, makeGaPropertyMainAction } =
  await import("./website-property-actions");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const FORM = { projectId: "p1", propertyId: "200" };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_AGENCY", "true");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({ workspaceId: "w1" });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.add.mockResolvedValue("ok");
  mocks.remove.mockResolvedValue("ok");
  mocks.makeMain.mockResolvedValue("ok");
});

describe("website property actions", () => {
  it("refuses a non-manager before touching anything", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const result = await addGaPropertyAction(form(FORM));
    expect(result).toEqual({
      ok: false,
      message: "Only workspace owners and admins can change this.",
    });
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses when GA_AGENCY is off", async () => {
    vi.stubEnv("GA_AGENCY", "");
    const result = await removeGaPropertyAction(form(FORM));
    expect(result.ok).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuses a project outside the dev allow-list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-x.neon.tech/app");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "other");
    const result = await makeGaPropertyMainAction(form(FORM));
    expect(result.ok).toBe(false);
    expect(mocks.makeMain).not.toHaveBeenCalled();
  });

  it("refuses a missing property id", async () => {
    const result = await addGaPropertyAction(form({ projectId: "p1" }));
    expect(result.ok).toBe(false);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it.each([
    ["add", addGaPropertyAction, mocks.add],
    ["remove", removeGaPropertyAction, mocks.remove],
    ["make main", makeGaPropertyMainAction, mocks.makeMain],
  ] as const)("%s succeeds, passes the actor and revalidates the site path", async (_name, action, change) => {
    const result = await action(form(FORM));
    expect(result).toEqual({ ok: true });
    expect(change).toHaveBeenCalledWith({
      projectId: "p1",
      propertyId: "200",
      actorUserId: "u1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1/site");
  });

  it("turns a business result into a user message without revalidating", async () => {
    mocks.add.mockResolvedValue("limit");
    expect(await addGaPropertyAction(form(FORM))).toEqual({
      ok: false,
      message: "You can add up to 4 extra properties.",
    });
    mocks.add.mockResolvedValue("already_linked");
    expect((await addGaPropertyAction(form(FORM))).ok).toBe(false);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not leak an error message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.add.mockRejectedValue(new Error("secret property name"));
    const result = await addGaPropertyAction(form(FORM));
    expect(result).toEqual({ ok: false, message: "The change could not be saved." });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "secret",
    );
  });
});
