import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  apply: vi.fn(),
  getKey: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    googleRiscEvent: {
      create: h.create,
      findUnique: h.findUnique,
      update: h.update,
    },
  },
}));
vi.mock("@/server/integrations/google/risc/apply", () => ({
  applyRiscEvents: h.apply,
}));
vi.mock("@/server/integrations/google/risc/jwks", () => ({
  getGoogleRiscKey: h.getKey,
}));

import {
  createTestRiscKey,
  signTestRiscToken,
  TEST_RISC_AUDIENCE,
} from "@/server/integrations/google/risc/test-support";

import { POST } from "./route";

const key = createTestRiscKey("kid-r");
const uniqueError = Object.assign(new Error("unique"), { code: "P2002" });

function post(body: string, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://example.com/api/webhooks/google-risc", {
      method: "POST",
      headers: { "content-type": "application/secevent+jwt", ...headers },
      body,
    }),
  );
}

const token = (claims: object = {}) =>
  signTestRiscToken(key, { jti: "jti-route", ...claims });

describe("POST /api/webhooks/google-risc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("GOOGLE_RISC", "true");
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", TEST_RISC_AUDIENCE);
    h.getKey.mockImplementation(async (kid: string) => (kid === key.kid ? key.jwk : null));
    h.create.mockResolvedValue({});
    h.update.mockResolvedValue({});
    h.apply.mockResolvedValue({ outcome: "APPLIED", matched: 1 });
  });

  it("answers 404 while the flag is off", async () => {
    vi.stubEnv("GOOGLE_RISC", "");
    expect((await post(token())).status).toBe(404);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("answers 202 and does nothing in mock mode", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    expect((await post(token())).status).toBe(202);
    expect(h.getKey).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("answers 202 and does nothing in a dev process sharing the live database", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-x.neon.tech/db");
    expect((await post(token())).status).toBe(202);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("answers 413 for an oversize body", async () => {
    expect((await post("a".repeat(70 * 1024))).status).toBe(413);
    expect(
      (await post("x", { "content-length": String(70 * 1024) })).status,
    ).toBe(413);
  });

  it("answers 400 for garbage and for an empty body", async () => {
    const response = await post("not-a-jwt");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_token" });
    expect((await post("")).status).toBe(400);
  });

  it("accepts the raw JWT body (content-type application/secevent+jwt), trimmed", async () => {
    const response = await post(`  ${token()}\n`);
    expect(response.status).toBe(202);
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it("rejects a token with a bad signature with 400", async () => {
    const forged = signTestRiscToken(createTestRiscKey("kid-r"), { jti: "x" });
    expect((await post(forged)).status).toBe(400);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("applies a duplicate jti only once", async () => {
    const jwt = token({ jti: "dup" });
    expect((await post(jwt)).status).toBe(202);
    h.create.mockRejectedValue(uniqueError);
    h.findUnique.mockResolvedValue({ outcome: "APPLIED", matched: 1 });
    expect((await post(jwt)).status).toBe(202);
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it("answers 500 when apply fails and applies on the retry", async () => {
    const jwt = token({ jti: "retry" });
    h.apply.mockRejectedValueOnce(new Error("db down"));
    expect((await post(jwt)).status).toBe(500);
    expect(h.update).not.toHaveBeenCalled();
    h.create.mockRejectedValue(uniqueError);
    h.findUnique.mockResolvedValue({ outcome: "PENDING", matched: 0 });
    expect((await post(jwt)).status).toBe(202);
    expect(h.apply).toHaveBeenCalledTimes(2);
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  it("answers 500 when the store throws", async () => {
    h.create.mockRejectedValue(new Error("connection reset"));
    expect((await post(token())).status).toBe(500);
  });

  it("never logs the token", async () => {
    const jwt = token();
    const spies = [
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    await post(jwt);
    await post("garbage-token-value");
    h.create.mockRejectedValue(new Error(jwt));
    await post(token({ jti: "other" }));
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const text = JSON.stringify(call);
        expect(text).not.toContain(jwt);
        expect(text).not.toContain("garbage-token-value");
      }
    }
    vi.restoreAllMocks();
  });
});
