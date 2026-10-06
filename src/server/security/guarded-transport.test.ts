import http from "node:http";
import https from "node:https";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRequestHeaders,
  guardedTransport,
  isBodyAllowed,
  type GuardedRequest,
} from "./guarded-transport";
import { UnsafeUrlError } from "./safe-fetch";

const REQUEST: GuardedRequest = {
  userAgent: "AgentelseSiteAudit/1.0 (+https://agentelse.com/bot)",
  accept: "text/html,application/xhtml+xml",
  maxBytes: 1_000,
  timeoutMs: 1_000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("guardedTransport", () => {
  it.each([
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "https://10.0.0.1/",
    "http://[::1]/",
  ])("rejects the private address %s before connecting", async (target) => {
    const httpRequest = vi.spyOn(http, "request");
    const httpsRequest = vi.spyOn(https, "request");
    await expect(
      guardedTransport(new URL(target), REQUEST),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(httpRequest).not.toHaveBeenCalled();
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it("rejects non-default ports and embedded credentials up front", async () => {
    const httpRequest = vi.spyOn(http, "request");
    await expect(
      guardedTransport(new URL("http://example.com:8080/"), REQUEST),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(
      guardedTransport(new URL("http://user:pw@example.com/"), REQUEST),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(httpRequest).not.toHaveBeenCalled();
  });
});

describe("buildRequestHeaders", () => {
  it("carries the given UA and accept with lowercased names", () => {
    const headers = buildRequestHeaders({
      ...REQUEST,
      headers: {
        "If-None-Match": '"abc"',
        "If-Modified-Since": "Mon, 05 Oct 2026 00:00:00 GMT",
      },
    });
    expect(headers).toEqual({
      "user-agent": REQUEST.userAgent,
      accept: REQUEST.accept,
      "accept-encoding": "gzip, deflate, br",
      "if-none-match": '"abc"',
      "if-modified-since": "Mon, 05 Oct 2026 00:00:00 GMT",
    });
    for (const name of Object.keys(headers)) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  it("works without extra headers", () => {
    expect(buildRequestHeaders(REQUEST)["user-agent"]).toBe(REQUEST.userAgent);
    expect(Object.keys(buildRequestHeaders(REQUEST))).toHaveLength(3);
  });
});

describe("isBodyAllowed", () => {
  const html = /^(text\/html|application\/xhtml\+xml)/i;

  it.each<[string | null, RegExp | undefined, boolean]>([
    [null, undefined, true],
    ["application/json", undefined, true],
    ["text/html; charset=utf-8", html, true],
    ["TEXT/HTML", html, true],
    ["application/xhtml+xml", html, true],
    ["  text/html", html, true],
    ["application/json", html, false],
    ["application/pdf", html, false],
    ["image/png", html, false],
    ["text/plain", html, false],
    ["", html, false],
    [null, html, false],
  ])("%s with %s → %s", (contentType, pattern, expected) => {
    expect(isBodyAllowed(contentType, pattern)).toBe(expected);
  });

  it("is not affected by a global flag's lastIndex", () => {
    const global = /text\/html/g;
    expect(isBodyAllowed("text/html", global)).toBe(true);
    expect(isBodyAllowed("text/html", global)).toBe(true);
  });
});
