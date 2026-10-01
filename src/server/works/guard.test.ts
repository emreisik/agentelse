import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorksEnabled: vi.fn(),
  isRateLimited: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/works/flag", () => ({
  isWorksEnabled: mocks.isWorksEnabled,
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import {
  assertWorkActive,
  authorizeWorks,
  guardedAction,
  readBoundedJson,
  refreshWorkPages,
} from "@/server/works/guard";

const OPTS = { bucket: "plan-pick", limit: 30 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isWorksEnabled.mockReturnValue(true);
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "w1",
    projectId: "p1",
    defaultBrandId: "b1",
  });
  mocks.isRateLimited.mockReturnValue(false);
});

describe("authorizeWorks", () => {
  it("rejects an invalid project id before anything else", async () => {
    for (const bad of [undefined, "", "x".repeat(65), 5]) {
      const r = await authorizeWorks(bad, OPTS);
      expect(r).toMatchObject({ ok: false, code: "INVALID" });
    }
    expect(mocks.requireUser).not.toHaveBeenCalled();
  });

  it("refuses when the flag is off", async () => {
    mocks.isWorksEnabled.mockReturnValue(false);
    const r = await authorizeWorks("p1", OPTS);
    expect(r).toEqual({
      ok: false,
      code: "DISABLED",
      message: "Works aren't available.",
    });
    expect(mocks.requireUser).not.toHaveBeenCalled();
  });

  it("rate limits per user inside the named bucket", async () => {
    mocks.isRateLimited.mockReturnValue(true);
    const r = await authorizeWorks("p1", OPTS);
    expect(r).toEqual({
      ok: false,
      code: "RATE",
      message: "Slow down for a moment.",
    });
    expect(mocks.isRateLimited).toHaveBeenCalledWith(
      "plan-pick:u1",
      30,
      10 * 60_000,
    );
  });

  it("passes a custom window", async () => {
    await authorizeWorks("p1", { bucket: "variants", limit: 3, windowMs: 60_000 });
    expect(mocks.isRateLimited).toHaveBeenCalledWith("variants:u1", 3, 60_000);
  });

  it("returns the workspace and default brand on success", async () => {
    const r = await authorizeWorks("p1", OPTS);
    expect(r).toEqual({
      ok: true,
      auth: { userId: "u1", workspaceId: "w1", defaultBrandId: "b1" },
    });
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("u1", "p1");
  });
});

describe("guardedAction", () => {
  it("passes a result through", async () => {
    expect(await guardedAction("x", async () => ({ ok: true }))).toEqual({
      ok: true,
    });
  });

  it("maps a throw to FAILED without leaking the message to the caller", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await guardedAction("pick", async () => {
      throw new Error("secret db detail");
    });
    expect(r).toEqual({
      ok: false,
      code: "FAILED",
      message: "That didn't work. Try again.",
    });
    expect(JSON.stringify(r)).not.toContain("secret");
    spy.mockRestore();
  });
});

describe("assertWorkActive", () => {
  const make = (row: { status: string } | null) => ({
    work: { findFirst: vi.fn().mockResolvedValue(row) },
  });

  it("accepts a null or undefined workId without a lookup", async () => {
    const db = make(null);
    expect(await assertWorkActive(db, { workId: null, projectId: "p1" })).toEqual(
      { ok: true },
    );
    expect(
      await assertWorkActive(db, { workId: undefined, projectId: "p1" }),
    ).toEqual({ ok: true });
    expect(db.work.findFirst).not.toHaveBeenCalled();
  });

  it("accepts an ACTIVE Work and looks it up with the project id", async () => {
    const db = make({ status: "ACTIVE" });
    expect(await assertWorkActive(db, { workId: "k1", projectId: "p1" })).toEqual(
      { ok: true },
    );
    expect(db.work.findFirst).toHaveBeenCalledWith({
      where: { id: "k1", projectId: "p1" },
      select: { status: true },
    });
  });

  it.each([["DONE"], ["ARCHIVED"]])("refuses a %s Work", async (status) => {
    const r = await assertWorkActive(make({ status }), {
      workId: "k1",
      projectId: "p1",
    });
    expect(r).toEqual({
      ok: false,
      message: "This Work is completed. Reopen it to continue.",
    });
  });

  it("refuses a missing Work", async () => {
    const r = await assertWorkActive(make(null), {
      workId: "k1",
      projectId: "p1",
    });
    expect(r.ok).toBe(false);
  });
});

function req(body: BodyInit, headers: Record<string, string>): Request {
  return new Request("http://localhost/x", { method: "POST", body, headers });
}

describe("readBoundedJson", () => {
  const JSON_H = { "content-type": "application/json" };

  it("refuses a wrong content type with 415", async () => {
    const r = await readBoundedJson(req("{}", { "content-type": "text/plain" }));
    expect(r).toMatchObject({ ok: false, status: 415 });
  });

  it("refuses a missing content type with 415", async () => {
    const r = await readBoundedJson(new Request("http://localhost/x", { method: "POST", body: "{}" , headers: {"content-type": ""}}));
    expect(r).toMatchObject({ ok: false, status: 415 });
  });

  it("refuses a Content-Length above the cap with 413", async () => {
    const r = await readBoundedJson(
      req("{}", { ...JSON_H, "content-length": "9000" }),
    );
    expect(r).toMatchObject({ ok: false, status: 413 });
  });

  it("refuses a body over the cap even with no Content-Length", async () => {
    const big = JSON.stringify({ a: "x".repeat(9000) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const request = new Request("http://localhost/x", {
      method: "POST",
      body: stream,
      headers: JSON_H,
      duplex: "half",
    } as RequestInit);
    expect(await readBoundedJson(request)).toMatchObject({
      ok: false,
      status: 413,
    });
  });

  it("honours a custom cap", async () => {
    const r = await readBoundedJson(req(JSON.stringify({ a: "x".repeat(50) }), JSON_H), {
      maxBytes: 20,
    });
    expect(r).toMatchObject({ ok: false, status: 413 });
  });

  it("refuses invalid JSON with 400", async () => {
    expect(await readBoundedJson(req("{nope", JSON_H))).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("returns the parsed value", async () => {
    expect(
      await readBoundedJson(
        req('{"a":1}', { "content-type": "application/json; charset=utf-8" }),
      ),
    ).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe("refreshWorkPages", () => {
  it("revalidates the project page and extras", () => {
    refreshWorkPages("p1", ["/projects/p1/isler"]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1/isler");
  });

  it("swallows a throwing revalidatePath", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.revalidatePath.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => refreshWorkPages("p1", ["/a"])).not.toThrow();
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
