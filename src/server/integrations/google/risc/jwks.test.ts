import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestRiscKey } from "./test-support";
import { getGoogleRiscKey, resetRiscKeyCache } from "./jwks";

const keyA = createTestRiscKey("kid-a");
const keyB = createTestRiscKey("kid-b");

function response(keys: { jwk: unknown }[], maxAgeSec: number | null = 3600) {
  return { status: 200, body: { keys: keys.map((key) => key.jwk) }, maxAgeSec };
}

describe("getGoogleRiscKey", () => {
  let clock = 1_000_000;
  const deps = (fetchJson: ReturnType<typeof vi.fn>) => ({
    fetchJson,
    now: () => clock,
  });

  beforeEach(() => {
    clock = 1_000_000;
    resetRiscKeyCache();
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves later lookups from the cache", async () => {
    const fetchJson = vi.fn().mockResolvedValue(response([keyA]));
    expect((await getGoogleRiscKey("kid-a", deps(fetchJson)))?.kid).toBe("kid-a");
    expect((await getGoogleRiscKey("kid-a", deps(fetchJson)))?.kid).toBe("kid-a");
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it("clamps max-age to 5 minutes at the low end and 24 hours at the high end", async () => {
    const fetchJson = vi.fn().mockResolvedValue(response([keyA], 1));
    await getGoogleRiscKey("kid-a", deps(fetchJson));
    clock += 4 * 60_000;
    await getGoogleRiscKey("kid-a", deps(fetchJson));
    expect(fetchJson).toHaveBeenCalledTimes(1);
    clock += 2 * 60_000;
    await getGoogleRiscKey("kid-a", deps(fetchJson));
    expect(fetchJson).toHaveBeenCalledTimes(2);

    resetRiscKeyCache();
    const long = vi.fn().mockResolvedValue(response([keyA], 10 * 24 * 3600));
    await getGoogleRiscKey("kid-a", deps(long));
    clock += 23 * 60 * 60_000;
    await getGoogleRiscKey("kid-a", deps(long));
    expect(long).toHaveBeenCalledTimes(1);
    clock += 2 * 60 * 60_000;
    await getGoogleRiscKey("kid-a", deps(long));
    expect(long).toHaveBeenCalledTimes(2);
  });

  it("refetches an unknown kid at most once per five minutes", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(response([keyA]))
      .mockResolvedValue(response([keyA, keyB]));
    await getGoogleRiscKey("kid-a", deps(fetchJson));
    // İlk çekimden hemen sonra bilinmeyen kid: yeniden çekim yok.
    expect(await getGoogleRiscKey("kid-b", deps(fetchJson))).toBeNull();
    expect(fetchJson).toHaveBeenCalledTimes(1);
    clock += 6 * 60_000;
    expect((await getGoogleRiscKey("kid-b", deps(fetchJson)))?.kid).toBe("kid-b");
    expect(fetchJson).toHaveBeenCalledTimes(2);
    // Hâlâ bilinmeyen bir kid: tekrar çekilmez.
    expect(await getGoogleRiscKey("kid-z", deps(fetchJson))).toBeNull();
    expect(await getGoogleRiscKey("kid-z", deps(fetchJson))).toBeNull();
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it("returns null on a failed fetch and backs off briefly", async () => {
    const fetchJson = vi.fn().mockRejectedValue(new Error("network"));
    expect(await getGoogleRiscKey("kid-a", deps(fetchJson))).toBeNull();
    expect(await getGoogleRiscKey("kid-a", deps(fetchJson))).toBeNull();
    expect(fetchJson).toHaveBeenCalledTimes(1);
    clock += 31_000;
    fetchJson.mockResolvedValue(response([keyA]));
    expect((await getGoogleRiscKey("kid-a", deps(fetchJson)))?.kid).toBe("kid-a");
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it("treats a non-200 or keyless body as a failure", async () => {
    const bad = vi.fn().mockResolvedValue({ status: 500, body: null, maxAgeSec: null });
    expect(await getGoogleRiscKey("kid-a", deps(bad))).toBeNull();
    resetRiscKeyCache();
    const empty = vi.fn().mockResolvedValue({ status: 200, body: { keys: [] }, maxAgeSec: null });
    expect(await getGoogleRiscKey("kid-a", deps(empty))).toBeNull();
  });

  it("never fetches in mock mode", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    const fetchJson = vi.fn().mockResolvedValue(response([keyA]));
    expect(await getGoogleRiscKey("kid-a", deps(fetchJson))).toBeNull();
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
