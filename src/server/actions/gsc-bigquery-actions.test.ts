import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: BigQuery eylemleri oturum ve proje erişimini
// doğrular, bayrak/açılış listesi dışını reddeder, yalnız OWNER/ADMIN'e açıktır,
// yabancı bağı reddeder, tavan seçeneklerini listeyle sınırlar, hiç fırlatmaz
// ve ham hata iletisini sızdırmaz.

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
const isWorkspaceManager = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
  isWorkspaceManager,
}));

const findBqLink = vi.fn();
const saveBqSource = vi.fn();
const setBqSourceState = vi.fn();
vi.mock("@/server/seo/agency/bq/source", () => ({
  findBqLink,
  saveBqSource,
  setBqSourceState,
}));
const verifyBqSource = vi.fn();
vi.mock("@/server/seo/agency/bq/verify", () => ({ verifyBqSource }));

const {
  saveBigQuerySourceAction,
  setBigQueryStateAction,
  verifyBigQuerySourceAction,
} = await import("./gsc-bigquery-actions");

const GIB = 1024 ** 3;

const form = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  data.set("projectId", "proj-1");
  data.set("linkId", "link-1");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const saveFields = {
  bqProjectId: "my-cloud-proj",
  dataset: "searchconsole",
  maxGb: "10",
  monthlyGb: "300",
  importAll: "on",
};

beforeEach(() => {
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_AGENCY", "true");
  vi.stubEnv("GSC_BIGQUERY", "true");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
  for (const mock of [
    revalidatePath,
    requireUser,
    requireProjectAccess,
    isWorkspaceManager,
    findBqLink,
    saveBqSource,
    setBqSourceState,
    verifyBqSource,
  ]) {
    mock.mockReset();
  }
  requireUser.mockResolvedValue({ userId: "user-1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: null,
  });
  isWorkspaceManager.mockResolvedValue(true);
  findBqLink.mockResolvedValue({ id: "link-1" });
  saveBqSource.mockResolvedValue({ ok: true });
  setBqSourceState.mockResolvedValue({ ok: true });
  verifyBqSource.mockResolvedValue({ ok: true, steps: [], errorCode: null });
});

describe("guards", () => {
  it("rejects every action when the flag is off", async () => {
    vi.stubEnv("GSC_BIGQUERY", "");
    expect((await saveBigQuerySourceAction(form(saveFields))).ok).toBe(false);
    expect((await setBigQueryStateAction(form({ state: "ON" }))).ok).toBe(false);
    expect((await verifyBigQuerySourceAction(form())).ok).toBe(false);
    expect(saveBqSource).not.toHaveBeenCalled();
    expect(setBqSourceState).not.toHaveBeenCalled();
    expect(verifyBqSource).not.toHaveBeenCalled();
  });

  it("rejects a project outside the rollout list", async () => {
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "other-project");
    expect((await setBigQueryStateAction(form({ state: "ON" }))).ok).toBe(false);
    expect(setBqSourceState).not.toHaveBeenCalled();
  });

  it("allows only workspace owners and admins", async () => {
    isWorkspaceManager.mockResolvedValue(false);
    const expected = {
      ok: false,
      message: "Only workspace owners and admins can change this.",
    };
    expect(await saveBigQuerySourceAction(form(saveFields))).toEqual(expected);
    expect(await setBigQueryStateAction(form({ state: "ON" }))).toEqual(expected);
    expect(await verifyBigQuerySourceAction(form())).toMatchObject(expected);
    expect(saveBqSource).not.toHaveBeenCalled();
    expect(verifyBqSource).not.toHaveBeenCalled();
  });

  it("rejects a link that is not this project's", async () => {
    findBqLink.mockResolvedValue(null);
    expect((await saveBigQuerySourceAction(form(saveFields))).ok).toBe(false);
    expect((await verifyBigQuerySourceAction(form())).ok).toBe(false);
    expect(findBqLink).toHaveBeenCalledWith("proj-1", "link-1");
    expect(saveBqSource).not.toHaveBeenCalled();
  });

  it("never throws: a failing session or store becomes a fixed message", async () => {
    requireProjectAccess.mockRejectedValue(new Error("secret: my-cloud-proj"));
    const save = await saveBigQuerySourceAction(form(saveFields));
    expect(save).toEqual({
      ok: false,
      message: "Something went wrong. Try again in a few minutes.",
    });
    const verify = await verifyBigQuerySourceAction(form());
    expect(verify.ok).toBe(false);
    expect(verify.result).toBeNull();
    expect(JSON.stringify(verify)).not.toContain("secret");
  });
});

describe("saveBigQuerySourceAction", () => {
  it("saves with byte caps from the allowed choices", async () => {
    expect(await saveBigQuerySourceAction(form(saveFields))).toEqual({ ok: true });
    expect(saveBqSource).toHaveBeenCalledWith({
      projectId: "proj-1",
      linkId: "link-1",
      bqProjectId: "my-cloud-proj",
      dataset: "searchconsole",
      maxBytesPerQuery: 10 * GIB,
      monthlyBudgetBytes: 300 * GIB,
      importAll: true,
      userId: "user-1",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");
  });

  it("treats a missing importAll as false", async () => {
    const { importAll, ...rest } = saveFields;
    void importAll;
    await saveBigQuerySourceAction(form(rest));
    expect(saveBqSource.mock.calls[0]![0].importAll).toBe(false);
  });

  it("refuses caps outside the choices", async () => {
    const out = await saveBigQuerySourceAction(form({ ...saveFields, maxGb: "9999" }));
    expect(out).toEqual({ ok: false, message: "Choose one of the listed cost caps." });
    expect((await saveBigQuerySourceAction(form({ ...saveFields, monthlyGb: "7" }))).ok).toBe(false);
    expect(saveBqSource).not.toHaveBeenCalled();
  });

  it("passes a refusal from the store (non-owner) through without revalidating", async () => {
    saveBqSource.mockResolvedValue({ ok: false, message: "Only the Search Console property owner can connect a BigQuery export." });
    const out = await saveBigQuerySourceAction(form(saveFields));
    expect(out.ok).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("verifyBigQuerySourceAction", () => {
  it("returns the step list", async () => {
    verifyBqSource.mockResolvedValue({
      ok: false,
      steps: [{ key: "ownership", label: "x", state: "fail", detail: "d" }],
      errorCode: "NOT_OWNER",
    });
    const out = await verifyBigQuerySourceAction(form());
    expect(out.ok).toBe(false);
    expect(out.result?.errorCode).toBe("NOT_OWNER");
    expect(verifyBqSource).toHaveBeenCalledWith({
      projectId: "proj-1",
      linkId: "link-1",
      userId: "user-1",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");
  });

  it("explains a rate limit", async () => {
    verifyBqSource.mockResolvedValue({
      ok: false,
      steps: [{ key: "ownership", label: "x", state: "skipped", detail: null }],
      errorCode: "RATE_LIMIT",
    });
    const out = await verifyBigQuerySourceAction(form());
    expect(out.ok).toBe(false);
    expect(out.message).toBe("Too many checks. Try again in a few minutes.");
  });
});

describe("setBigQueryStateAction", () => {
  it.each(["ON", "PAUSE", "REMOVE"])("passes %s to the store", async (state) => {
    expect(await setBigQueryStateAction(form({ state }))).toEqual({ ok: true });
    expect(setBqSourceState).toHaveBeenCalledWith({
      projectId: "proj-1",
      linkId: "link-1",
      state,
      userId: "user-1",
    });
  });

  it("rejects an unknown state", async () => {
    expect((await setBigQueryStateAction(form({ state: "DROP" }))).ok).toBe(false);
    expect(setBqSourceState).not.toHaveBeenCalled();
  });

  it("returns the store's refusal", async () => {
    setBqSourceState.mockResolvedValue({ ok: false, message: "Verify the export first (within the last 24 hours)." });
    expect(await setBigQueryStateAction(form({ state: "ON" }))).toEqual({
      ok: false,
      message: "Verify the export first (within the last 24 hours).",
    });
  });
});
