import { describe, expect, it } from "vitest";

import {
  INDEXNOW_ENDPOINT,
  INDEXNOW_MAX_URLS_PER_CHANGE,
  INDEXNOW_MIN_GAP_MS,
  buildIndexNowBody,
  generateIndexNowKey,
  indexNowKeyUrl,
  indexNowOutcome,
  isValidIndexNowKey,
  keyFileMatches,
} from "./indexnow";

const KEY = "0123456789abcdef0123456789abcdef";

describe("generateIndexNowKey", () => {
  it("makes 32 lowercase hex characters from 16 bytes", () => {
    const calls: number[] = [];
    const key = generateIndexNowKey((n) => {
      calls.push(n);
      return Uint8Array.from({ length: n }, (_, i) => i * 17);
    });
    expect(calls).toEqual([16]);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key.startsWith("001122")).toBe(true);
    expect(isValidIndexNowKey(key)).toBe(true);
  });
});

describe("isValidIndexNowKey", () => {
  it("accepts 8 to 128 letters, digits and dashes", () => {
    expect(isValidIndexNowKey(KEY)).toBe(true);
    expect(isValidIndexNowKey("abcd-123")).toBe(true);
    expect(isValidIndexNowKey("a".repeat(128))).toBe(true);
  });

  it("refuses everything else", () => {
    expect(isValidIndexNowKey("short")).toBe(false);
    expect(isValidIndexNowKey("a".repeat(129))).toBe(false);
    expect(isValidIndexNowKey("has space 1234")).toBe(false);
    expect(isValidIndexNowKey("slash/12345678")).toBe(false);
    expect(isValidIndexNowKey(12345678)).toBe(false);
    expect(isValidIndexNowKey(null)).toBe(false);
  });
});

describe("indexNowKeyUrl", () => {
  it("points at the key file at the site root", () => {
    expect(indexNowKeyUrl("example.com", KEY)).toBe(`https://example.com/${KEY}.txt`);
  });
});

describe("buildIndexNowBody", () => {
  it("builds the body with the key location", () => {
    expect(
      buildIndexNowBody({ host: "example.com", key: KEY, urls: ["https://example.com/a"] }),
    ).toEqual({
      host: "example.com",
      key: KEY,
      keyLocation: `https://example.com/${KEY}.txt`,
      urlList: ["https://example.com/a"],
    });
  });

  it("drops other hosts and http, and dedupes", () => {
    const body = buildIndexNowBody({
      host: "example.com",
      key: KEY,
      urls: [
        "https://example.com/a",
        "http://example.com/b",
        "https://other.com/c",
        "https://example.com/a#frag",
        "https://example.com/a",
        "not a url",
        "https://EXAMPLE.com/d",
      ],
    });
    expect(body?.urlList).toEqual(["https://example.com/a", "https://example.com/d"]);
  });

  it("keeps at most 5 urls", () => {
    const urls = Array.from({ length: 9 }, (_, i) => `https://example.com/p${i}`);
    const body = buildIndexNowBody({ host: "example.com", key: KEY, urls });
    expect(body?.urlList).toHaveLength(INDEXNOW_MAX_URLS_PER_CHANGE);
  });

  it("returns null when nothing is left or the key is invalid", () => {
    expect(buildIndexNowBody({ host: "example.com", key: KEY, urls: [] })).toBeNull();
    expect(buildIndexNowBody({ host: "example.com", key: KEY, urls: ["http://example.com/a"] })).toBeNull();
    expect(buildIndexNowBody({ host: "example.com", key: "bad", urls: ["https://example.com/a"] })).toBeNull();
    expect(buildIndexNowBody({ host: "", key: KEY, urls: ["https://example.com/a"] })).toBeNull();
  });
});

describe("indexNowOutcome", () => {
  it("maps the status codes", () => {
    expect(indexNowOutcome(200)).toBe("SENT");
    expect(indexNowOutcome(202)).toBe("SENT");
    expect(indexNowOutcome(403)).toBe("KEY_INVALID");
    expect(indexNowOutcome(422)).toBe("URL_MISMATCH");
    expect(indexNowOutcome(429)).toBe("RATE_LIMITED");
    expect(indexNowOutcome(400)).toBe("FAILED");
    expect(indexNowOutcome(500)).toBe("FAILED");
  });
});

describe("keyFileMatches", () => {
  it("compares the trimmed body to the key", () => {
    expect(keyFileMatches(KEY, KEY)).toBe(true);
    expect(keyFileMatches(`﻿ ${KEY}\n`, KEY)).toBe(true);
    expect(keyFileMatches(`${KEY}x`, KEY)).toBe(false);
    expect(keyFileMatches("<html></html>", KEY)).toBe(false);
    expect(keyFileMatches("", "")).toBe(false);
  });
});

describe("constants", () => {
  it("has the endpoint and a 10 minute gap", () => {
    expect(INDEXNOW_ENDPOINT).toBe("https://api.indexnow.org/indexnow");
    expect(INDEXNOW_MIN_GAP_MS).toBe(10 * 60_000);
  });
});
