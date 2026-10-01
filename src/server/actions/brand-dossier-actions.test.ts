import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// The "Suggest with AI" action on the Brand Dossier card is a public POST. It
// checks its argument, the flag, the session and project access, and a rate
// limit before any model call, hands the suggestion service only ids it derived
// itself, and answers a generic message when anything goes wrong.

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const isRateLimited = vi.fn();
vi.mock("@/lib/rate-limit", () => ({ isRateLimited }));

const guidedEnabled = vi.fn();
vi.mock("@/server/guided-setup/flag", () => ({
  isGuidedSetupEnabled: guidedEnabled,
}));

const suggestDossierFill = vi.fn();
vi.mock("@/server/brand/dossier-suggest", () => ({ suggestDossierFill }));

const { suggestBrandDossierAction } = await import("./brand-dossier-actions");

const PROJECT = "proj-1";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  guidedEnabled.mockReturnValue(true);
  requireUser.mockResolvedValue({ userId: "u1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: PROJECT,
    defaultBrandId: "brand-1",
  });
  isRateLimited.mockReturnValue(false);
  suggestDossierFill.mockResolvedValue({
    status: "FILLED",
    filled: ["services", "products"],
  });
});

describe("suggestBrandDossierAction", () => {
  it("fills for the signed-in member, with ids it derived itself, and refreshes the page", async () => {
    const result = await suggestBrandDossierAction(PROJECT);

    expect(result).toEqual({
      ok: true,
      status: "FILLED",
      filled: ["services", "products"],
    });
    expect(suggestDossierFill).toHaveBeenCalledWith(
      { workspaceId: "ws-1", projectId: PROJECT, brandId: "brand-1" },
      { trigger: "button", userId: "u1" },
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${PROJECT}`);
  });

  it("does not refresh the page when nothing was filled", async () => {
    suggestDossierFill.mockResolvedValue({
      status: "NOTHING_TO_FILL",
      filled: [],
    });

    expect(await suggestBrandDossierAction(PROJECT)).toEqual({
      ok: true,
      status: "NOTHING_TO_FILL",
      filled: [],
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 42, {}, "", "x".repeat(65)])(
    "refuses the argument %j before anything is read",
    async (value) => {
      const result = await suggestBrandDossierAction(value as never);

      expect(result.ok).toBe(false);
      expect(requireUser).not.toHaveBeenCalled();
      expect(suggestDossierFill).not.toHaveBeenCalled();
    },
  );

  it("answers that it is unavailable when the flag is off, before the session", async () => {
    guidedEnabled.mockReturnValue(false);

    const result = await suggestBrandDossierAction(PROJECT);

    expect(result).toEqual({
      ok: false,
      message: "AI suggestions aren't available.",
    });
    expect(requireUser).not.toHaveBeenCalled();
    expect(suggestDossierFill).not.toHaveBeenCalled();
  });

  it("refuses a caller without access to the project, without a model call", async () => {
    requireProjectAccess.mockRejectedValue(new Error("no access"));

    const result = await suggestBrandDossierAction(PROJECT);

    expect(result.ok).toBe(false);
    expect(suggestDossierFill).not.toHaveBeenCalled();
  });

  it("refuses a project that has no default brand", async () => {
    requireProjectAccess.mockResolvedValue({
      workspaceId: "ws-1",
      projectId: PROJECT,
    });

    expect((await suggestBrandDossierAction(PROJECT)).ok).toBe(false);
    expect(suggestDossierFill).not.toHaveBeenCalled();
  });

  it("rate limits per person and project before the model is asked", async () => {
    isRateLimited.mockReturnValue(true);

    const result = await suggestBrandDossierAction(PROJECT);

    expect(result.ok).toBe(false);
    expect(isRateLimited).toHaveBeenCalledWith(
      `dossier-suggest:u1:${PROJECT}`,
      3,
      10 * 60_000,
    );
    expect(suggestDossierFill).not.toHaveBeenCalled();
  });

  it("answers one generic message when the suggestion throws, without its text", async () => {
    suggestDossierFill.mockRejectedValue(new Error("secret provider detail"));

    const result = await suggestBrandDossierAction(PROJECT);

    expect(result).toEqual({
      ok: false,
      message: "Couldn't get suggestions. Try again in a minute.",
    });
  });

  it("keeps a saved suggestion ok when the cache purge itself fails", async () => {
    revalidatePath.mockImplementation(() => {
      throw new Error("purge failed");
    });

    expect(await suggestBrandDossierAction(PROJECT)).toMatchObject({
      ok: true,
      status: "FILLED",
    });
  });

  it("is a use server file whose only runtime export is the one action", () => {
    const source = readFileSync(
      join(process.cwd(), "src/server/actions/brand-dossier-actions.ts"),
      "utf8",
    );

    expect(source.split("\n")[0]).toBe('"use server";');
    const exports = [...source.matchAll(/^export (?:async )?(\w+)\s+(\w+)/gm)]
      .filter(([, kind]) => kind !== "type")
      .map(([, , name]) => name);
    expect(exports).toEqual(["suggestBrandDossierAction"]);
  });
});
