import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleFlowStep } from "@/lib/module-flows/card";
import type { SeoState } from "@/lib/module-flows/seo/state";

// Arka plan işleri: cevap yalnız sahiplik hâlâ bu çalıştırmanınsa yazılır,
// başarısızlıkta sahiplik bırakılır ve hata karta yazılır, hiçbir şey fırlatmaz.
// Kart yazıcısı bellekteki bir kartın üzerinde gerçek güncelleme fonksiyonunu
// çalıştırır.

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  revalidatePath: vi.fn(),
  runAction: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/works/guard", () => ({
  GUARD_MESSAGE: { failed: "That didn't work. Try again." },
}));
vi.mock("@/server/seo/actions/verify", () => ({
  SeoActionVerifier: { runAction: mocks.runAction },
}));

type Card = { step: ModuleFlowStep; state: SeoState };
let stored: Card;

vi.mock("@/server/modules/seo/card", () => ({
  writeSeoCard: vi.fn(
    async (input: {
      update: (
        current: Card,
      ) => Card | { reject: string };
    }) => {
      const next = input.update(structuredClone(stored));
      if ("reject" in next) return { ok: false, message: next.reject };
      stored = next;
      return { ok: true, ...next };
    },
  ),
  releaseSeoRun: vi.fn(
    async (input: { runId: string; step: ModuleFlowStep }) => {
      if (stored.state.run?.id === input.runId) {
        const state = { ...stored.state };
        delete state.run;
        stored = { step: input.step, state };
      }
    },
  ),
}));

import {
  runSeoClaimed,
  runSeoJob,
  scheduleSeoJob,
  verifyActionSoon,
  type SeoJob,
} from "./background";

const NOW = new Date("2026-10-07T10:00:00.000Z");

function claimedCard(runId: string, extra: Partial<SeoState> = {}): Card {
  return {
    step: "create",
    state: {
      run: { id: runId, kind: "write", startedAt: NOW.toISOString() },
      ...extra,
    },
  };
}

function job(
  overrides: Partial<SeoJob<string>> = {},
): SeoJob<string> {
  return {
    projectId: "p1",
    commandId: "c1",
    runId: "run1",
    kind: "write",
    fallbackStep: "plan",
    call: async () => ({ ok: true, value: "done" }),
    finish: ({ state }, value) => ({
      step: "review",
      state: {
        ...state,
        article: {
          title: value,
          metaDescription: "",
          markdown: "x",
          writtenAt: NOW.toISOString(),
          rewrites: 0,
        },
      },
    }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  stored = claimedCard("run1");
  delete process.env.SEO_ACTIONS;
});

describe("runSeoJob", () => {
  it("sahiplik sürerken cevabı yazar ve run'ı kaldırır", async () => {
    const after = vi.fn(async () => undefined);
    await runSeoJob(job({ after }));
    expect(stored.step).toBe("review");
    expect(stored.state.article?.title).toBe("done");
    expect(stored.state.run).toBeUndefined();
    expect(after).toHaveBeenCalledWith("done");
  });

  it("sahiplik başkasına geçtiyse cevabı yazmaz", async () => {
    const before = claimedCard("other");
    stored = before;
    await runSeoJob(
      job({
        call: async () => ({ ok: true, value: "late" }),
      }),
    );
    expect(stored).toEqual(before);
  });

  it("evreleri yalnız kendi çalıştırması için yazar", async () => {
    let seen: string | undefined;
    await runSeoJob(
      job({
        call: async (setPhase) => {
          await setPhase("writing");
          seen = stored.state.run?.phase;
          return { ok: true, value: "done" };
        },
      }),
    );
    expect(seen).toBe("writing");

    stored = claimedCard("other");
    await runSeoJob(
      job({
        call: async (setPhase) => {
          await setPhase("checking");
          return { ok: false, message: "x" };
        },
      }),
    );
    expect(stored.state.run?.phase).toBeUndefined();
  });

  it("başarısızlıkta sahipliği bırakır, adıma döner ve hatayı karta yazar", async () => {
    await runSeoJob(
      job({
        call: async () => ({ ok: false, message: "Couldn't write the article. Try again." }),
      }),
    );
    expect(stored.step).toBe("plan");
    expect(stored.state.run).toBeUndefined();
    expect(stored.state.lastError).toMatchObject({
      runId: "run1",
      kind: "write",
      message: "Couldn't write the article. Try again.",
    });
  });

  it("çağrı fırlatırsa genel hata iletisiyle bırakır ve fırlatmaz", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runSeoJob(
        job({
          call: async () => {
            throw new Error("secret detail");
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(stored.state.lastError?.message).toBe("That didn't work. Try again.");
    expect(JSON.stringify(stored)).not.toContain("secret detail");
    spy.mockRestore();
  });

  it("yan işin hatası sonucu bozmaz", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runSeoJob(
        job({
          after: async () => {
            throw new Error("touch failed");
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(stored.step).toBe("review");
    spy.mockRestore();
  });
});

describe("scheduleSeoJob", () => {
  it("işi after() ile zamanlar", () => {
    mocks.after.mockImplementation(() => undefined);
    scheduleSeoJob(job());
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(stored.state.run?.id).toBe("run1");
  });

  it("after() kullanılamazsa işi ayrık başlatır", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.after.mockImplementation(() => {
      throw new Error("outside request scope");
    });
    scheduleSeoJob(job());
    await vi.waitFor(() => expect(stored.step).toBe("review"));
    spy.mockRestore();
  });
});

describe("verifyActionSoon", () => {
  it("doğrulayıcıyı cevaptan sonra çalıştırır; hatası fırlamaz", async () => {
    mocks.after.mockImplementation((fn: () => Promise<void>) => fn());
    mocks.runAction.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    verifyActionSoon("a1");
    await vi.waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith("a1"));
    spy.mockRestore();
  });
});

describe("runSeoClaimed", () => {
  const copy = { busy: "busy", stale: "stale" };

  function run(overrides: Partial<Parameters<typeof runSeoClaimed<string>>[0]> = {}) {
    return runSeoClaimed<string>({
      projectId: "p1",
      commandId: "c1",
      kind: "write",
      fallbackStep: "plan",
      phase: "writing",
      copy,
      claim: ({ state }) => ({ step: "create", state }),
      call: async () => ({ ok: true, value: "done" }),
      finish: ({ state }) => ({ step: "review", state }),
      message: "Your article is ready.",
      ...overrides,
    });
  }

  beforeEach(() => {
    stored = { step: "plan", state: {} };
  });

  it("canlı damga yokken eşzamanlı çalışır ve evre yazmaz", async () => {
    const afterDone = vi.fn(async () => undefined);
    const result = await run({ afterDone });
    expect(result).toEqual({ ok: true, message: "Your article is ready." });
    expect(stored.step).toBe("review");
    expect(stored.state.run).toBeUndefined();
    expect(afterDone).toHaveBeenCalledWith("done");
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1");
  });

  it("bayrak kapalıyken features.live olsa da eşzamanlıdır", async () => {
    stored = { step: "plan", state: { features: { modes: true, live: true } } };
    const result = await run();
    expect(result).toEqual({ ok: true, message: "Your article is ready." });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("bayrak açık ve damga canlıyken runId ile hemen döner", async () => {
    process.env.SEO_ACTIONS = "true";
    stored = { step: "plan", state: { features: { modes: true, live: true } } };
    mocks.after.mockImplementation(() => undefined);
    const result = await run();
    expect(result).toMatchObject({
      ok: true,
      message: "Working on it. This card updates live.",
    });
    expect(result.ok && result.runId).toBeTruthy();
    expect(stored.step).toBe("create");
    expect(stored.state.run).toMatchObject({ kind: "write", phase: "writing" });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    delete process.env.SEO_ACTIONS;
  });

  it("çalışan kartı ikinci kez sahiplenmez ve eski hatayı yeni koşuda siler", async () => {
    stored = {
      step: "plan",
      state: {
        run: { id: "x", kind: "write", startedAt: new Date().toISOString() },
      },
    };
    const busy = await run();
    expect(busy).toEqual({ ok: false, message: "busy" });

    stored = {
      step: "plan",
      state: {
        lastError: { runId: "old", kind: "write", message: "old", at: "2026-10-06T00:00:00.000Z" },
      },
    };
    await run();
    expect(stored.state.lastError).toBeUndefined();
  });

  it("başarısız çağrıda sahipliği bırakır ve iletiyi döndürür", async () => {
    const result = await run({
      call: async () => ({ ok: false, message: "No luck." }),
    });
    expect(result).toEqual({ ok: false, message: "No luck." });
    expect(stored.step).toBe("plan");
    expect(stored.state.run).toBeUndefined();
  });

  it("claim reddederse STALE kodu taşır", async () => {
    const result = await run({ claim: () => ({ reject: "stale" }) });
    expect(result).toEqual({ ok: false, message: "stale", code: "STALE" });
  });
});
