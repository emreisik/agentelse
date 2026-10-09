import { describe, expect, it } from "vitest";

import { readLimitedBody } from "./read-limited-body";

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://app.test/hook", { method: "POST", body, headers });

describe("readLimitedBody", () => {
  it("accepts a body of exactly the limit and rejects one byte more", async () => {
    const exactly = await readLimitedBody(post("x".repeat(100)), 100);
    expect(exactly?.length).toBe(100);
    expect(await readLimitedBody(post("x".repeat(101)), 100)).toBeNull();
  });

  it("counts the bytes it reads, whatever Content-Length claims", async () => {
    expect(
      await readLimitedBody(
        post("x".repeat(500), { "content-length": "5" }),
        100,
      ),
    ).toBeNull();
  });

  it("refuses at once when Content-Length already says it is too big", async () => {
    expect(
      await readLimitedBody(post("tiny", { "content-length": "9999" }), 100),
    ).toBeNull();
  });

  it("an empty body is an empty buffer", async () => {
    const request = new Request("https://app.test/hook", { method: "POST" });
    expect((await readLimitedBody(request, 100))?.length).toBe(0);
  });
});
