import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import notFound from "./__fixtures__/crux-not-found.json";
import record from "./__fixtures__/crux-record.json";
import {
  CRUX_HISTORY_ENDPOINT,
  CRUX_RECORD_ENDPOINT,
  CruxApiError,
  CruxBlockedError,
  queryCruxHistory,
  queryCruxRecord,
} from "./crux-api";

// Bu dosyanın kanıtladığı: anahtar yalnız X-Goog-Api-Key başlığında gider
// (URL'de değil), metrik listesi gönderilmez; 404 = veri yok; 403 ve
// "API key" diyen 400 CruxBlockedError'dır ve mesajında anahtar yoktur;
// 429 fırlatır; mock modunda fetch hiç çağrılmaz.

const KEY = "AIzaSy-secret-test-key";
const fetchMock = vi.fn();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  vi.stubEnv("GOOGLE_API_KEY", KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("queryCruxRecord", () => {
  it("sends the key only in the X-Goog-Api-Key header", async () => {
    fetchMock.mockResolvedValueOnce(json(200, record));
    const parsed = await queryCruxRecord(
      { origin: "https://www.example.com" },
      "PHONE",
      { fetchImpl: fetchMock },
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CRUX_RECORD_ENDPOINT);
    expect(url).not.toContain(KEY);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "X-Goog-Api-Key": KEY,
    });
    expect(JSON.parse(String(init.body))).toEqual({
      origin: "https://www.example.com",
      formFactor: "PHONE",
    });
    expect(String(init.body)).not.toContain(KEY);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(parsed?.p75.lcp).toBe(2900);
  });

  it("returns null on 404", async () => {
    fetchMock.mockResolvedValueOnce(json(404, notFound));
    await expect(
      queryCruxRecord({ url: "https://www.example.com/x" }, "DESKTOP", {
        fetchImpl: fetchMock,
      }),
    ).resolves.toBeNull();
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
    );
    expect(body).toEqual({
      url: "https://www.example.com/x",
      formFactor: "DESKTOP",
    });
  });

  it("throws CruxBlockedError on 403 and on an API key 400, without the key", async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, {
        error: { code: 403, message: `Requests from key ${KEY} are blocked.` },
      }),
    );
    const blocked = await queryCruxRecord(
      { origin: "https://www.example.com" },
      "PHONE",
      { fetchImpl: fetchMock },
    ).catch((caught: unknown) => caught);
    expect(blocked).toBeInstanceOf(CruxBlockedError);
    expect((blocked as Error).message).not.toContain(KEY);

    fetchMock.mockResolvedValueOnce(
      json(400, {
        error: {
          code: 400,
          message: "API key not valid. Please pass a valid API key.",
        },
      }),
    );
    const invalid = await queryCruxRecord(
      { origin: "https://www.example.com" },
      "PHONE",
      { fetchImpl: fetchMock },
    ).catch((caught: unknown) => caught);
    expect(invalid).toBeInstanceOf(CruxBlockedError);
  });

  it("throws on 429", async () => {
    fetchMock.mockResolvedValueOnce(json(429, { error: { code: 429 } }));
    const error = await queryCruxRecord(
      { origin: "https://www.example.com" },
      "PHONE",
      { fetchImpl: fetchMock },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CruxApiError);
    expect((error as CruxApiError).httpStatus).toBe(429);
  });

  it("is blocked without a key", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "  ");
    await expect(
      queryCruxRecord({ origin: "https://www.example.com" }, "PHONE", {
        fetchImpl: fetchMock,
      }),
    ).rejects.toBeInstanceOf(CruxBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("queryCruxHistory", () => {
  it("uses the history endpoint and returns [] on 404", async () => {
    fetchMock.mockResolvedValueOnce(json(404, notFound));
    await expect(
      queryCruxHistory({ origin: "https://www.example.com" }, "PHONE", {
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0]![0]).toBe(CRUX_HISTORY_ENDPOINT);
  });
});

describe("mock mode", () => {
  it("never calls fetch and serves the fixture-like records", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    vi.stubEnv("GOOGLE_API_KEY", "");
    const phone = await queryCruxRecord(
      { origin: "https://www.example.com" },
      "PHONE",
      { fetchImpl: fetchMock },
    );
    const desktop = await queryCruxRecord(
      { origin: "https://www.example.com" },
      "DESKTOP",
      { fetchImpl: fetchMock },
    );
    const home = await queryCruxRecord(
      { url: "https://www.example.com/" },
      "PHONE",
      { fetchImpl: fetchMock },
    );
    const other = await queryCruxRecord(
      { url: "https://www.example.com/pricing" },
      "PHONE",
      { fetchImpl: fetchMock },
    );
    const history = await queryCruxHistory(
      { origin: "https://www.example.com" },
      "PHONE",
      { fetchImpl: fetchMock },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(phone?.p75).toMatchObject({ lcp: 2900, inp: 180, cls: 0.05 });
    expect(desktop?.p75.lcp).toBeLessThanOrEqual(2500);
    expect(home).not.toBeNull();
    expect(other).toBeNull();
    expect(history).toHaveLength(25);
  });
});
