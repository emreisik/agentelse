import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SeoCardRead } from "@/server/modules/seo/card";

// Canlı uç: bayrak ve yetki; çalışan bir kart için `run` olayları, bitişte
// `end`, `?run=` ile eşleşen hata ve istek iptalinde yoklamanın durması. Kart
// okuması sıralı bir sahtedir; zaman sahte saatle ilerler.

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

const readSeoCard = vi.fn();
vi.mock("@/server/modules/seo/card", () => ({ readSeoCard }));

const { GET } = await import("./route");
const { AgentelseError } = await import("@/server/security/errors");

const NOW = new Date("2026-10-07T10:00:00.000Z");
const params = {
  params: Promise.resolve({ projectId: "p1", commandId: "c1" }),
};

function request(query = "", signal?: AbortSignal) {
  return new Request(
    `http://localhost/api/projects/p1/seo/cards/c1/live${query}`,
    signal ? { signal } : {},
  );
}

function card(
  state: SeoCardRead["state"],
  step: SeoCardRead["step"] = "plan",
): SeoCardRead {
  return {
    card: {
      kind: "module-flow",
      module: "seo",
      title: "SEO Manager",
      step,
      data: {},
    },
    step,
    state,
    workId: "w1",
  };
}

const running = (phase?: "reading_page" | "writing") =>
  card(
    {
      run: {
        id: "run1",
        kind: "write",
        startedAt: new Date(NOW.getTime() - 5_000).toISOString(),
        ...(phase ? { phase } : {}),
      },
    },
    "create",
  );

async function drain(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
}

const original = process.env.SEO_ACTIONS;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW });
  process.env.SEO_ACTIONS = "true";
  requireUser.mockResolvedValue({ userId: "u1", email: null });
  requireProjectAccess.mockResolvedValue({ workspaceId: "ws1" });
});

afterEach(() => {
  vi.useRealTimers();
  if (original === undefined) delete process.env.SEO_ACTIONS;
  else process.env.SEO_ACTIONS = original;
});

describe("GET /api/projects/[projectId]/seo/cards/[commandId]/live", () => {
  it("bayrak kapalıyken 404 döner ve oturuma bakmaz", async () => {
    delete process.env.SEO_ACTIONS;
    const response = await GET(request(), params);
    expect(response.status).toBe(404);
    expect(requireUser).not.toHaveBeenCalled();
  });

  it("oturum yoksa 401, yetkisiz projede 404 döner", async () => {
    requireUser.mockRejectedValueOnce(
      new AgentelseError("LOGIN_REQUIRED", "Authentication required"),
    );
    expect((await GET(request(), params)).status).toBe(401);
    requireProjectAccess.mockRejectedValueOnce(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    expect((await GET(request(), params)).status).toBe(404);
    expect(readSeoCard).not.toHaveBeenCalled();
  });

  it("kart yoksa 404 döner", async () => {
    readSeoCard.mockResolvedValue(null);
    expect((await GET(request(), params)).status).toBe(404);
  });

  it("akış başlıkları doğrudur", async () => {
    readSeoCard.mockResolvedValue(card({}));
    const response = await GET(request(), params);
    expect(response.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    await drain(response);
  });

  it("çalışan kart için run olayları, bitince end olayı yollar", async () => {
    readSeoCard
      .mockResolvedValueOnce(running("reading_page"))
      .mockResolvedValueOnce(running("reading_page"))
      .mockResolvedValueOnce(running("writing"))
      .mockResolvedValue(card({}, "review"));
    const response = await GET(request("?run=run1"), params);
    const text = drain(response);
    await vi.advanceTimersByTimeAsync(10_000);
    const body = await text;

    const runs = [...body.matchAll(/event: run\ndata: (.*)\n/g)].map((m) =>
      JSON.parse(m[1]!),
    );
    // Aynı durum iki kez yollanmaz: reading_page bir, writing bir kez.
    expect(runs).toEqual([
      { running: true, kind: "write", phase: "reading_page" },
      { running: true, kind: "write", phase: "writing" },
    ]);
    expect(body).toContain('event: end\ndata: {"ok":true,"step":"review"}');
    expect(body.indexOf("event: end")).toBeGreaterThan(body.lastIndexOf("event: run"));
  });

  it("?run= ile eşleşen lastError'ı hata olarak bildirir", async () => {
    const failedCard = card({
      lastError: {
        runId: "run1",
        kind: "write",
        message: "Couldn't write the article. Try again.",
        at: NOW.toISOString(),
      },
    });
    readSeoCard.mockResolvedValue(failedCard);
    const text = drain(await GET(request("?run=run1"), params));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await text).toContain(
      'event: end\ndata: {"ok":false,"message":"Couldn\'t write the article. Try again."}',
    );
  });

  it("başka bir çalıştırmanın lastError'ını bildirmez", async () => {
    readSeoCard.mockResolvedValue(
      card({
        lastError: {
          runId: "old",
          kind: "write",
          message: "old failure",
          at: NOW.toISOString(),
        },
      }),
    );
    const text = drain(await GET(request("?run=run1"), params));
    await vi.advanceTimersByTimeAsync(2_000);
    const body = await text;
    expect(body).not.toContain("old failure");
    expect(body).toContain('"ok":true');
  });

  it("istek iptal edilince yoklamayı durdurur", async () => {
    readSeoCard.mockResolvedValue(running("writing"));
    const controller = new AbortController();
    const response = await GET(request("?run=run1", controller.signal), params);
    const text = drain(response);
    await vi.advanceTimersByTimeAsync(3_100);
    const readsBefore = readSeoCard.mock.calls.length;
    expect(readsBefore).toBeGreaterThan(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readSeoCard.mock.calls.length).toBe(readsBefore);
    await text;
  });

  it("10 sn sessizlikte ping yollar", async () => {
    readSeoCard.mockResolvedValue(running("writing"));
    const controller = new AbortController();
    const response = await GET(request("?run=run1", controller.signal), params);
    const text = drain(response);
    await vi.advanceTimersByTimeAsync(11_000);
    controller.abort();
    expect(await text).toContain(": ping");
  });

  it("kullanıcı başına en çok 3 eşzamanlı akışa izin verir, 4.'yü 429 ile reddeder", async () => {
    readSeoCard.mockResolvedValue(running("writing"));
    const controllers = [0, 1, 2].map(() => new AbortController());
    const open = await Promise.all(
      controllers.map((c) => GET(request("?run=run1", c.signal), params)),
    );
    const texts = open.map((response) => drain(response));
    expect(open.every((response) => response.status === 200)).toBe(true);

    const refused = await GET(request("?run=run1"), params);
    expect(refused.status).toBe(429);

    // Bir akış kapanınca yer açılır.
    controllers[0]!.abort();
    await vi.advanceTimersByTimeAsync(10);
    const again = await GET(request("?run=run1", controllers[1]!.signal), params);
    expect(again.status).toBe(200);
    const againText = drain(again);
    controllers.forEach((c) => c.abort());
    await Promise.all([...texts, againText]);
  });

  it("akış sürerken üyelik kalkarsa bir dakika içinde akışı kapatır", async () => {
    readSeoCard.mockResolvedValue(running("writing"));
    const response = await GET(request("?run=run1"), params);
    const text = drain(response);
    requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    await vi.advanceTimersByTimeAsync(62_000);
    expect(await text).toContain(
      'event: end\ndata: {"ok":false,"message":"You no longer have access to this project."}',
    );
  });
});
