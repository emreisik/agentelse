import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { InstagramOverview } from "@/lib/instagram-overview";

const { InstagramOverviewView } = await import("./instagram-overview-card");

// What this suite proves: each state of the Instagram card says the right
// thing, in Turkish: loading shows a placeholder only, a working connection
// shows the account, the 28-day totals and the latest posts, a connection
// without the insights permission still shows the account and points to a
// reconnect, an expired one says so, and a project without Instagram renders
// nothing.

const render = (
  state: Parameters<typeof InstagramOverviewView>[0]["state"],
) =>
  renderToStaticMarkup(
    createElement(InstagramOverviewView, { projectId: "proj-1", state }),
  );
const done = (overview: InstagramOverview) =>
  render({ status: "done", overview });

const profile = {
  username: "webhealth",
  name: "Web Health",
  pictureUrl: "https://cdn/avatar.jpg",
  followers: 12_345,
  follows: 80,
  posts: 1_234,
};
const posts = [
  {
    id: "1",
    caption: "Bir gönderi",
    imageUrl: "https://cdn/1.jpg",
    permalink: "https://www.instagram.com/p/1/",
    timestamp: null,
    likes: 120,
    comments: 8,
  },
  {
    id: "2",
    caption: null,
    imageUrl: null,
    permalink: null,
    timestamp: null,
    likes: null,
    comments: null,
  },
];

describe("InstagramOverviewView", () => {
  it("shows only a placeholder while loading", () => {
    const html = render({ status: "loading" });
    expect(html).toContain('data-card="instagram-overview"');
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Takipçi");
  });

  it("shows the account, the totals and the latest posts when everything was read", () => {
    const html = done({
      ok: true,
      profile,
      insights: {
        reach: 4_200,
        views: 15_000,
        accounts_engaged: 310,
        total_interactions: 0,
      },
      insightsMissing: null,
      posts,
    });

    expect(html).toContain("Web Health");
    expect(html).toContain("@webhealth");
    expect(html).toContain("Takipçi");
    expect(html).toMatch(/12,3\s?B/);
    expect(html).toContain("Son 28 gün");
    expect(html).toContain("Erişilen hesap");
    expect(html).toContain("4.200");
    expect(html).toContain("Görüntülenme");
    expect(html).toContain("Etkileşime giren hesap");
    expect(html).toContain("Toplam etkileşim");
    expect(html).toContain("Son gönderiler");
    expect(html).toContain('href="https://www.instagram.com/p/1/"');
    expect(html).toContain('rel="noopener noreferrer"');
    // (120 + 8) / 1 counted post / 12.345 followers = %1,0
    expect(html).toContain("%1");
    expect(html).not.toContain("yeniden bağlayın");
  });

  it("still shows the account when the insights permission is missing, and points to a reconnect", () => {
    const html = done({
      ok: true,
      profile,
      insights: null,
      insightsMissing: "permission",
      posts: [],
    });

    expect(html).toContain("Takipçi");
    expect(html).toContain("Erişim ve görüntülenme için ek izin gerekiyor.");
    expect(html).toContain('href="/projects/proj-1/integrations"');
    expect(html).not.toContain("Erişilen hesap");
    expect(html).not.toContain("Son gönderiler");
  });

  it("says the totals could not be read when Meta did not answer, without asking for a reconnect", () => {
    const html = done({
      ok: true,
      profile,
      insights: null,
      insightsMissing: "error",
      posts: [],
    });

    expect(html).toContain("Erişim verisi şu an okunamadı.");
    expect(html).not.toContain("yeniden bağlayın");
  });

  it("falls back to the handle when the account has no name, and to initials without a picture", () => {
    const html = done({
      ok: true,
      profile: { ...profile, name: null, pictureUrl: null },
      insights: {},
      insightsMissing: null,
      posts: [],
    });

    expect(html).toContain("@webhealth");
    expect(html).toContain(">IG<");
  });

  it("asks for a reconnect when the connection expired", () => {
    const html = done({ ok: false, reason: "expired" });

    expect(html).toContain("Bağlantının süresi dolmuş.");
    expect(html).toContain('href="/projects/proj-1/integrations"');
  });

  it("says the data could not be read on an error", () => {
    expect(done({ ok: false, reason: "error" })).toContain(
      "Instagram verisi şu an okunamadı.",
    );
  });

  it("renders nothing for a project without Instagram", () => {
    expect(done({ ok: false, reason: "not_connected" })).toBe("");
  });
});
