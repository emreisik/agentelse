import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const denyUnlessProjectMember = vi.fn();
const loadCalendarData = vi.fn();
const loadCalendarDetail = vi.fn();

vi.mock("@/server/calendar/route-auth", () => ({
  denyUnlessProjectMember: (...args: unknown[]) =>
    denyUnlessProjectMember(...args),
}));
vi.mock("@/server/calendar/load-calendar", () => ({
  loadCalendarData: (...args: unknown[]) => loadCalendarData(...args),
}));
vi.mock("@/server/calendar/load-detail", () => ({
  loadCalendarDetail: (...args: unknown[]) => loadCalendarDetail(...args),
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: async () => "Europe/Istanbul",
}));

const { GET } = await import("./route");
const { GET: GET_DETAIL } = await import("./[creativeId]/route");

const ctx = { params: Promise.resolve({ projectId: "p1" }) };
const get = (query: string) =>
  GET(new Request(`http://localhost/api/projects/p1/calendar${query}`), ctx);

beforeEach(() => {
  vi.clearAllMocks();
  denyUnlessProjectMember.mockResolvedValue(null);
  loadCalendarData.mockResolvedValue({
    items: [],
    connections: [],
    scheduleEnabled: true,
    loadedAt: 1,
  });
});

describe("GET /api/projects/[id]/calendar", () => {
  it("üye değilse veriyi hiç okumadan reddeder", async () => {
    denyUnlessProjectMember.mockResolvedValue(
      NextResponse.json({ error: "Not found" }, { status: 404 }),
    );
    const response = await get("?from=2026-09-28&to=2026-11-01");
    expect(response.status).toBe(404);
    expect(loadCalendarData).not.toHaveBeenCalled();
  });

  it("geçerli aralıkta proje saat dilimiyle okur ve önbelleğe almaz", async () => {
    const response = await get("?from=2026-09-28&to=2026-11-01");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const call = loadCalendarData.mock.calls[0]![0];
    expect(call.projectId).toBe("p1");
    expect(call.timezone).toBe("Europe/Istanbul");
    // İstanbul UTC+3: 28 Eylül 00:00 yerel = 27 Eylül 21:00 UTC.
    expect(call.from.toISOString()).toBe("2026-09-27T21:00:00.000Z");
    // Son günün 23:59:59'u yerel = 1 Kasım 20:59:59 UTC.
    expect(call.to.toISOString()).toBe("2026-11-01T20:59:59.999Z");
  });

  it("eksik, ters ya da çok uzun aralığı reddeder", async () => {
    for (const query of [
      "",
      "?from=2026-09-28",
      "?from=bozuk&to=2026-11-01",
      "?from=2026-11-01&to=2026-09-28",
      "?from=2026-01-01&to=2026-12-31",
    ]) {
      expect((await get(query)).status).toBe(400);
    }
    expect(loadCalendarData).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/[id]/calendar/[creativeId]", () => {
  const detailCtx = {
    params: Promise.resolve({ projectId: "p1", creativeId: "c1" }),
  };
  const getDetail = () =>
    GET_DETAIL(new Request("http://localhost/x"), detailCtx);

  it("üye değilse reddeder, parça yoksa 404 verir, varsa ayrıntıyı döner", async () => {
    denyUnlessProjectMember.mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    expect((await getDetail()).status).toBe(401);
    expect(loadCalendarDetail).not.toHaveBeenCalled();

    loadCalendarDetail.mockResolvedValueOnce(null);
    expect((await getDetail()).status).toBe(404);

    loadCalendarDetail.mockResolvedValueOnce({ caption: "x", approvalId: null });
    const ok = await getDetail();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ caption: "x", approvalId: null });
    expect(loadCalendarDetail).toHaveBeenLastCalledWith("p1", "c1");
  });
});
