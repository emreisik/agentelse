import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  isRateLimited: vi.fn(),
  seoApplyEnabledFor: vi.fn(),
  connectWordPress: vi.fn(),
  testWordPress: vi.fn(),
  disconnectWordPress: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/lib/seo/apply/flags", () => ({ seoApplyEnabledFor: mocks.seoApplyEnabledFor }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/server/integrations/wordpress/connect", () => ({
  connectWordPress: mocks.connectWordPress,
  testWordPress: mocks.testWordPress,
  disconnectWordPress: mocks.disconnectWordPress,
}));

import { AgentelseError } from "@/server/security/errors";

import {
  connectWordPressAction,
  disconnectWordPressAction,
  testWordPressAction,
} from "./wordpress-actions";

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const CONNECT_FORM = {
  projectId: "p1",
  siteUrl: "https://example.com",
  username: "editor",
  appPassword: "abcdefghijklmnopqrstuvwx",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "w1",
    projectId: "p1",
    defaultBrandId: "b1",
  });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.isRateLimited.mockReturnValue(false);
  mocks.seoApplyEnabledFor.mockReturnValue(true);
  mocks.connectWordPress.mockResolvedValue({ ok: true, view: {} });
  mocks.testWordPress.mockResolvedValue({ ok: true, view: {} });
  mocks.disconnectWordPress.mockResolvedValue({ ok: true });
});

describe("connectWordPressAction", () => {
  it("yönetici bağlar: alanlar, çalışma alanı ve marka iletilir, sayfa yenilenir", async () => {
    expect(await connectWordPressAction(form(CONNECT_FORM))).toEqual({ ok: true });
    expect(mocks.connectWordPress).toHaveBeenCalledWith({
      projectId: "p1",
      workspaceId: "w1",
      brandId: "b1",
      userId: "u1",
      siteUrl: "https://example.com",
      username: "editor",
      appPassword: "abcdefghijklmnopqrstuvwx",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1/integrations");
  });

  it("yönetici olmayan üye bağlayamaz ve bağlantı koduna hiç gidilmez", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const result = await connectWordPressAction(form(CONNECT_FORM));
    expect(result).toEqual({ ok: false, message: "Only a workspace owner or admin can do this." });
    expect(mocks.connectWordPress).not.toHaveBeenCalled();
    expect(mocks.isRateLimited).not.toHaveBeenCalled();
  });

  it("bayrak kapalıyken reddeder", async () => {
    mocks.seoApplyEnabledFor.mockReturnValue(false);
    const result = await connectWordPressAction(form(CONNECT_FORM));
    expect(result.ok).toBe(false);
    expect(mocks.connectWordPress).not.toHaveBeenCalled();
  });

  it("hız sınırı aşılınca denemez", async () => {
    mocks.isRateLimited.mockReturnValue(true);
    const result = await connectWordPressAction(form(CONNECT_FORM));
    expect(result).toEqual({ ok: false, message: "Too many attempts. Try again in a few minutes." });
    expect(mocks.connectWordPress).not.toHaveBeenCalled();
    expect(mocks.isRateLimited.mock.calls[0]![0]).toBe("wordpress-connect:u1:p1");
  });

  it("bağlantı hatası sabit mesaja çevrilir ve sayfa yenilenmez", async () => {
    mocks.connectWordPress.mockResolvedValue({
      ok: false,
      code: "bad_credentials",
      message: "WordPress did not accept that username and Application Password.",
    });
    const result = await connectWordPressAction(form(CONNECT_FORM));
    expect(result).toEqual({
      ok: false,
      message: "WordPress did not accept that username and Application Password.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("fırlatan hata ActionResult olur (şifre mesaja girmez)", async () => {
    mocks.connectWordPress.mockRejectedValue(new Error("Database unavailable"));
    const result = await connectWordPressAction(form(CONNECT_FORM));
    expect(result).toEqual({ ok: false, message: "WordPress could not be connected" });
    expect(JSON.stringify(result)).not.toContain(CONNECT_FORM.appPassword);
  });

  it("oturum yoksa fırlatmaz ve ham hata metnini döndürmez", async () => {
    mocks.requireUser.mockRejectedValue(new Error("Unauthorized"));
    expect(await connectWordPressAction(form(CONNECT_FORM))).toEqual({
      ok: false,
      message: "WordPress could not be connected",
    });
  });

  it("erişim hataları sabit metne çevrilir: kimlik sızmaz", async () => {
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("PERMISSION_DENIED", "User u1 has no access to workspace w9"),
    );
    const result = await connectWordPressAction(form(CONNECT_FORM));
    expect(result).toEqual({ ok: false, message: "This project isn't available." });
    mocks.requireUser.mockRejectedValue(new AgentelseError("LOGIN_REQUIRED", "x"));
    expect(await connectWordPressAction(form(CONNECT_FORM))).toEqual({
      ok: false,
      message: "Please sign in again.",
    });
  });
});

describe("testWordPressAction", () => {
  it("her üye sınayabilir; rebind yalnız yöneticide dikkate alınır", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    expect(await testWordPressAction(form({ projectId: "p1", rebind: "1" }))).toEqual({ ok: true });
    expect(mocks.testWordPress).toHaveBeenLastCalledWith("p1", {
      userId: "u1",
      isManager: false,
      rebind: false,
    });

    mocks.isWorkspaceManager.mockResolvedValue(true);
    await testWordPressAction(form({ projectId: "p1", rebind: "1" }));
    expect(mocks.testWordPress).toHaveBeenLastCalledWith("p1", {
      userId: "u1",
      isManager: true,
      rebind: true,
    });

    await testWordPressAction(form({ projectId: "p1" }));
    expect(mocks.testWordPress).toHaveBeenLastCalledWith("p1", {
      userId: "u1",
      isManager: true,
      rebind: false,
    });
  });

  it("bayrak kapalıyken siteye hiç istek atılmaz", async () => {
    mocks.seoApplyEnabledFor.mockReturnValue(false);
    const result = await testWordPressAction(form({ projectId: "p1" }));
    expect(result).toEqual({
      ok: false,
      message: "Website changes are not switched on for this project.",
    });
    expect(mocks.testWordPress).not.toHaveBeenCalled();
  });

  it("test hatası mesaja çevrilir; hız sınırı çalışır", async () => {
    mocks.testWordPress.mockResolvedValue({
      ok: false,
      code: "unreachable",
      message: "Agentelse could not reach that address. Check it and try again.",
    });
    const failed = await testWordPressAction(form({ projectId: "p1" }));
    expect(failed).toEqual({
      ok: false,
      message: "Agentelse could not reach that address. Check it and try again.",
    });
    mocks.isRateLimited.mockReturnValue(true);
    const limited = await testWordPressAction(form({ projectId: "p1" }));
    expect(limited.ok).toBe(false);
    expect(mocks.testWordPress).toHaveBeenCalledTimes(1);
  });
});

describe("disconnectWordPressAction", () => {
  it("yalnız yönetici koparabilir", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const refused = await disconnectWordPressAction(form({ projectId: "p1" }));
    expect(refused).toEqual({ ok: false, message: "Only a workspace owner or admin can do this." });
    expect(mocks.disconnectWordPress).not.toHaveBeenCalled();

    mocks.isWorkspaceManager.mockResolvedValue(true);
    expect(await disconnectWordPressAction(form({ projectId: "p1" }))).toEqual({ ok: true });
    expect(mocks.disconnectWordPress).toHaveBeenCalledWith({
      projectId: "p1",
      workspaceId: "w1",
      userId: "u1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1/integrations");
  });

  it("busy mesajı döner", async () => {
    mocks.disconnectWordPress.mockResolvedValue({
      ok: false,
      code: "busy",
      message: "A change is being applied right now. Try again in a minute.",
    });
    expect(await disconnectWordPressAction(form({ projectId: "p1" }))).toEqual({
      ok: false,
      message: "A change is being applied right now. Try again in a minute.",
    });
  });
});
