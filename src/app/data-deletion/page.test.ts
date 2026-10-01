import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ getEnv: () => ({ AUTH_SECRET: "auth-secret" }) }));

const { default: DataDeletionPage } = await import("./page");
const { createDeletionCode } = await import("@/lib/meta-signed-request");

async function render(code?: string) {
  const element = await DataDeletionPage({
    searchParams: Promise.resolve(code === undefined ? {} : { code }),
  });
  return renderToStaticMarkup(createElement(() => element));
}

const now = Date.UTC(2026, 9, 1, 12, 0, 0);

describe("data deletion page", () => {
  it("always explains how to delete the data, without a code", async () => {
    const html = await render();
    expect(html).toContain("How to delete your Instagram data");
    expect(html).toContain("Apps and websites");
    expect(html).toContain("hello@agentelse.ai");
    expect(html).not.toContain("deletion-status");
  });

  it("shows the status of a request opened with its signed confirmation code", async () => {
    const code = createDeletionCode(1, "auth-secret", now);
    const html = await render(code);
    expect(html).toContain('data-testid="deletion-status"');
    expect(html).toContain("Your request was processed");
    expect(html).toContain("2026-10-01");
    expect(html).toContain("1 connection");
    expect(html).toContain(code);
  });

  it("says plainly when there was nothing to erase", async () => {
    const html = await render(createDeletionCode(0, "auth-secret", now));
    expect(html).toContain("nothing to erase");
  });

  it("ignores a made-up or tampered code and just shows the instructions", async () => {
    for (const bad of ["abc", createDeletionCode(1, "other-secret", now), "x".repeat(35)]) {
      const html = await render(bad);
      expect(html).not.toContain("deletion-status");
      expect(html).toContain("How to delete your Instagram data");
    }
  });
});
