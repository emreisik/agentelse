import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ AUTH_SECRET: "auth-secret" }),
}));

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

  it("says disconnecting Google Analytics deletes the website reports (GA-F5)", async () => {
    const html = (await render()).replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    expect(html).toContain("website reports Agentelse posted");
    expect(html).toContain(
      "Your own messages in that chat stay until you delete the chat",
    );
  });

  it("shows the status of a request opened with its signed confirmation code", async () => {
    const code = createDeletionCode(1, "auth-secret", now);
    const html = await render(code);
    expect(html).toContain('data-testid="deletion-status"');
    expect(html).toContain("Your request was processed");
    expect(html).toContain("2026-10-01");
    expect(html).toContain("1 connection");
    expect(html).toContain("connection record");
    expect(html).toContain(code);
    // It does not claim more than the record: the rest of the workspace stays.
    expect(html).toContain("stay there until it is deleted");
  });

  it("when nothing matched, says so honestly instead of claiming no data was held", async () => {
    const html = await render(createDeletionCode(0, "auth-secret", now));
    expect(html).toContain("could not match this request");
    expect(html).toContain("Facebook Page or Meta Ads");
    expect(html).not.toContain("did not hold");
    expect(html).not.toContain("nothing to erase");
  });

  it("names the real menu (Connectors) and does not list Disconnect as a way to erase", async () => {
    const html = await render();
    expect(html).toContain("Connectors");
    expect(html).not.toContain("Integrations");
    // Disconnect is explained separately, as stopping use, not erasing.
    expect(html).toContain("does not erase");
    expect(html).toContain("either of these");
  });

  it("also explains how to erase the Facebook Page and Meta Ads records", async () => {
    const html = await render();
    expect(html).toContain(
      "How to delete your Facebook Page and Meta Ads data",
    );
    expect(html).toContain("Page access tokens are never stored");
    expect(html).toContain("Connectors &gt; Facebook &gt; Disconnect");
    expect(html).toContain("Connectors &gt; Meta Ads &gt; Disconnect");
    expect(html).toContain("Business integrations");
    expect(html).toContain("/privacy#facebook-and-meta-ads");
  });

  it("says Disconnect deletes the stored Search Console history, and how to delete it without disconnecting", async () => {
    const html = await render();
    expect(html).toContain("deletes the search history Agentelse stored");
    expect(html).toContain("Delete stored data");
  });

  it("says what Disconnect deletes from the search audit, and how to delete the site audit data", async () => {
    const html = await render();
    expect(html).toContain(
      "URL Inspection results, sitemap status and search alerts",
    );
    expect(html).toContain("Delete audit data");
  });

  it("says Disconnect also deletes the search opportunity data (SC-F4)", async () => {
    const html = await render();
    expect(html).toContain(
      "search opportunities, topic groups and brand-term suggestions",
    );
  });

  it("says Disconnect also deletes the lessons from tagged links (GA-F6) and the measured SEO results (SC-F6)", async () => {
    const html = await render();
    expect(html).toContain("lessons learned from your tagged links");
    expect(html).toContain(
      "the measured results of SEO changes and the learnings drawn from them",
    );
  });

  it("ignores a made-up or tampered code and just shows the instructions", async () => {
    for (const bad of [
      "abc",
      createDeletionCode(1, "other-secret", now),
      "x".repeat(35),
    ]) {
      const html = await render(bad);
      expect(html).not.toContain("deletion-status");
      expect(html).toContain("How to delete your Instagram data");
    }
  });
});
