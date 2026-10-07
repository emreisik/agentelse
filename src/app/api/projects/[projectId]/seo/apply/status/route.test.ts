import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (SC-F8 durum ucu): bayrak kapalıyken hiçbir okuma
// olmadan 404; oturum yoksa 401, proje erişimi yoksa 404; geçersiz makale
// kimliği 400; başarılı yanıt PublishStatusView biçiminde ve "private, no-store".

const mocks = vi.hoisted(() => ({
  denyUnlessProjectMember: vi.fn(),
  requireUser: vi.fn(),
  loadPublishStatus: vi.fn(),
}));

vi.mock("@/server/calendar/route-auth", () => ({
  denyUnlessProjectMember: mocks.denyUnlessProjectMember,
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
}));
vi.mock("@/server/seo/apply/read", () => ({
  loadPublishStatus: mocks.loadPublishStatus,
}));

import { GET } from "./route";

const NAMES = ["SEO_APPLY", "SEO_HEALTH"] as const;
const ORIGINAL: Record<string, string | undefined> = Object.fromEntries(
  NAMES.map((name) => [name, process.env[name]]),
);

const VIEW = {
  connected: true,
  healthy: true,
  canPropose: true,
  blockedReason: null,
  change: null,
  liveChange: null,
  isManager: true,
  connectHref: "/projects/p1/integrations?integration=wordpress",
};

function call(query = "creativeId=cr1") {
  return GET(
    new Request(`https://app.example.com/api/projects/p1/seo/apply/status?${query}`),
    { params: Promise.resolve({ projectId: "p1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SEO_APPLY = "true";
  process.env.SEO_HEALTH = "true";
  mocks.denyUnlessProjectMember.mockResolvedValue(null);
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.loadPublishStatus.mockResolvedValue(VIEW);
});

afterEach(() => {
  for (const name of NAMES) {
    if (ORIGINAL[name] === undefined) delete process.env[name];
    else process.env[name] = ORIGINAL[name];
  }
});

describe("seo apply status route", () => {
  it("answers 404 before any read when the flag is off", async () => {
    process.env.SEO_APPLY = "";
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.denyUnlessProjectMember).not.toHaveBeenCalled();
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.loadPublishStatus).not.toHaveBeenCalled();
  });

  it("answers 404 when SEO_HEALTH is off, even with SEO_APPLY on", async () => {
    process.env.SEO_HEALTH = "";
    expect((await call()).status).toBe(404);
    expect(mocks.loadPublishStatus).not.toHaveBeenCalled();
  });

  it("passes the session and access refusals through without reading", async () => {
    mocks.denyUnlessProjectMember.mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const unauthorized = await call();
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Cache-Control")).toBe("private, no-store");

    mocks.denyUnlessProjectMember.mockResolvedValueOnce(
      NextResponse.json({ error: "Not found" }, { status: 404 }),
    );
    expect((await call()).status).toBe(404);
    expect(mocks.loadPublishStatus).not.toHaveBeenCalled();
  });

  it("rejects a missing or malformed creative id", async () => {
    expect((await call("")).status).toBe(400);
    expect((await call("creativeId=a%20b%2F..")).status).toBe(400);
    expect(mocks.loadPublishStatus).not.toHaveBeenCalled();
  });

  it("returns the status view with no-store", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(VIEW);
    expect(mocks.loadPublishStatus).toHaveBeenCalledWith({
      projectId: "p1",
      creativeId: "cr1",
      userId: "u1",
    });
  });

  it("answers 404 when the reader returns nothing", async () => {
    mocks.loadPublishStatus.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
