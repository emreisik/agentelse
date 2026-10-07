import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { viewFixtures } from "@/lib/seo/apply/test-support";
import type {
  PublishStatusView,
  SeoChangeView,
} from "@/lib/seo/apply/view-types";

// Bu dosyanın kanıtladığı ("Publish to WordPress (draft)" bloğu): her durum
// görünür: bağlı değil, sağlıksız, hiç önerilmedi, onay bekliyor (yönetici satır
// içi onaylar, üye "Waiting for an owner or admin" görür), uygulanıyor, taslak
// hazır, yayına alma bekliyor, yayında, hata (sabit metin; yazısı inmiş hatada
// Undo), geri alındı. Yoklama 4 sn, en çok 3 dk, aralık temizlenir; ilk çizimde
// hiçbir şey gösterilmez ve istek yapılmaz.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/seo-apply-actions", () => ({
  decideSeoChangeAction: vi.fn(),
  proposeMakeLiveAction: vi.fn(),
  proposePublishArticleAction: vi.fn(),
  undoSeoChangeAction: vi.fn(),
}));

const { PublishStatusBody, PublishToWordPress } = await import(
  "./publish-to-wordpress"
);

function article(overrides: Partial<SeoChangeView> = {}): SeoChangeView {
  return viewFixtures.change({
    id: "chg_a",
    kind: "PUBLISH_ARTICLE",
    title: "Create a WordPress draft",
    draft: true,
    ...overrides,
  });
}

function live(overrides: Partial<SeoChangeView> = {}): SeoChangeView {
  return viewFixtures.change({
    id: "chg_l",
    kind: "PUBLISH_LIVE",
    title: "Publish a WordPress draft",
    ...overrides,
  });
}

function status(overrides: Partial<PublishStatusView> = {}): PublishStatusView {
  return {
    connected: true,
    healthy: true,
    canPropose: true,
    blockedReason: null,
    change: null,
    liveChange: null,
    isManager: true,
    connectHref: "/projects/project-1/integrations?integration=wordpress",
    ...overrides,
  };
}

function html(model: PublishStatusView, isManager = true, compact = false): string {
  return renderToStaticMarkup(
    createElement(PublishStatusBody, {
      projectId: "project-1",
      creativeId: "creative-1",
      status: model,
      isManager,
      compact,
    }),
  );
}

describe("PublishStatusBody", () => {
  it("links to the connectors page when WordPress is not connected", () => {
    const markup = html(status({ connected: false, healthy: false, canPropose: false }));
    expect(markup).toContain("Connect WordPress to send this article as a draft.");
    expect(markup).toContain("/projects/project-1/integrations?integration=wordpress");
    expect(markup).not.toContain("Publish to WordPress (draft)");
  });

  it("explains an unhealthy connection with the blocked reason", () => {
    const markup = html(
      status({
        healthy: false,
        canPropose: false,
        blockedReason: "The WordPress connection is not healthy. Check it in the WordPress settings.",
      }),
    );
    expect(markup).toContain("The WordPress connection is not healthy");
    expect(markup).toContain("Check the connection");
    expect(markup).not.toContain("Publish to WordPress (draft)");
  });

  it("offers the draft button with the approval and calendar notes", () => {
    const markup = html(status());
    expect(markup).toContain("Publish to WordPress (draft)");
    expect(markup).toContain('name="projectId" value="project-1"');
    expect(markup).toContain('name="creativeId" value="creative-1"');
    expect(markup).toContain("Nothing is created on WordPress until an owner or admin approves.");
    expect(markup).toContain(
      "Scheduling this article on the calendar does not schedule the WordPress post.",
    );
  });

  it("shows a blocked reason instead of the button when it cannot be proposed", () => {
    const markup = html(
      status({ canPropose: false, blockedReason: "The WordPress user is not allowed to make this change. Use an Editor user." }),
    );
    expect(markup).toContain("Use an Editor user.");
    expect(markup).not.toContain("Publish to WordPress (draft)");
  });

  it("lets a manager approve inline and a member only wait", () => {
    const manager = html(status({ change: article({ canDecide: true }) }));
    expect(manager).toContain("Waiting for approval");
    expect(manager).toContain("Approve and create the draft");
    expect(manager).toContain('name="decision" value="approve"');
    expect(manager).toContain('name="changeId" value="chg_a"');

    const member = html(
      status({ isManager: false, change: article({ canDecide: false }) }),
      false,
    );
    expect(member).toContain("Waiting for an owner or admin");
    expect(member).not.toContain("Approve and create the draft");
  });

  it("shows progress while the change is being applied", () => {
    for (const [value, label] of [
      ["APPROVED", "Approved, applying"],
      ["APPLYING", "Applying"],
      ["APPLIED", "Applied, checking"],
    ] as const) {
      const markup = html(
        status({
          canPropose: false,
          change: article({ status: value, statusLabel: label, canDecide: false }),
        }),
      );
      expect(markup).toContain(label);
      expect(markup).not.toContain("Publish to WordPress (draft)");
    }
  });

  it("shows the draft link, the make-live button and Undo with its warning", () => {
    const markup = html(
      status({
        canPropose: false,
        change: article({
          status: "VERIFIED",
          statusLabel: "Done and checked",
          canDecide: false,
          canMakeLive: true,
          canUndo: true,
          undoWarning: "Undo moves the draft to the WordPress Trash.",
          link: "https://example.com/?p=7",
        }),
      }),
    );
    expect(markup).toContain("Draft created on WordPress");
    expect(markup).toContain('href="https://example.com/?p=7"');
    expect(markup).toContain("Make it live (needs approval)");
    expect(markup).toContain("Makes the article visible to everyone.");
    expect(markup).toContain("Undo moves the draft to the WordPress Trash.");
    expect(markup).toContain(">Undo<");
  });

  it("hides Undo from members", () => {
    const markup = html(
      status({
        isManager: false,
        canPropose: false,
        change: article({
          status: "VERIFIED",
          canDecide: false,
          canUndo: true,
          undoWarning: "Undo moves the draft to the WordPress Trash.",
        }),
      }),
      false,
    );
    expect(markup).not.toContain(">Undo<");
  });

  it("shows the make-live approval step", () => {
    const verified = article({ status: "VERIFIED", canDecide: false, canMakeLive: false });
    const manager = html(
      status({
        canPropose: false,
        change: verified,
        liveChange: live({ canDecide: true }),
      }),
    );
    expect(manager).toContain("Making it live: waiting for approval");
    expect(manager).toContain("Approve and make it live");
    expect(manager).toContain('name="changeId" value="chg_l"');
    expect(manager).not.toContain("Make it live (needs approval)");

    const member = html(
      status({
        isManager: false,
        canPropose: false,
        change: verified,
        liveChange: live({ canDecide: false }),
      }),
      false,
    );
    expect(member).toContain("Waiting for an owner or admin");
  });

  it("offers a retry after a live attempt that wrote nothing", () => {
    const markup = html(
      status({
        canPropose: false,
        change: article({
          status: "VERIFIED",
          canDecide: false,
          canMakeLive: true,
          canUndo: true,
          undoWarning: "Undo moves the draft to the WordPress Trash.",
        }),
        liveChange: live({
          status: "FAILED",
          statusLabel: "Didn't work",
          canDecide: false,
          canUndo: false,
          error: {
            code: "page_changed",
            message: "The page changed in the meantime. Nothing was changed.",
          },
        }),
      }),
    );
    expect(markup).toContain("The page changed in the meantime");
    expect(markup).toContain("Make it live (needs approval)");
    // Hiçbir şey yazılmadığı için makalenin kendi geri alması da açık kalır.
    expect(markup).toContain(">Undo<");
  });

  it("shows the live page with an Undo that makes it a draft again", () => {
    const markup = html(
      status({
        canPropose: false,
        change: article({
          status: "VERIFIED",
          canDecide: false,
          canMakeLive: false,
          canUndo: true,
          undoWarning: "Undo moves the draft to the WordPress Trash.",
        }),
        liveChange: live({
          status: "VERIFIED",
          statusLabel: "Done and checked",
          canDecide: false,
          canUndo: true,
          undoWarning: "Undo makes the article a draft again.",
          link: "https://example.com/my-article/",
        }),
      }),
    );
    expect(markup).toContain("Live on your site");
    expect(markup).toContain('href="https://example.com/my-article/"');
    expect(markup).toContain("Undo makes the article a draft again.");
    // Yayındayken makalenin kendi geri almasi sunulmaz.
    expect(markup).not.toContain("Undo moves the draft to the WordPress Trash.");
  });

  it("shows the fixed failure text, Undo for a written failure and a retry", () => {
    const markup = html(
      status({
        canPropose: true,
        change: article({
          status: "FAILED",
          statusLabel: "Didn't work",
          canDecide: false,
          canUndo: true,
          undoWarning: "Undo moves the draft to the WordPress Trash.",
          error: {
            code: "readback_mismatch",
            message:
              "WordPress accepted the change but showed something different afterwards. Check the page in WordPress, or undo the change here.",
          },
        }),
      }),
    );
    expect(markup).toContain("showed something different afterwards");
    expect(markup).toContain(">Undo<");
    expect(markup).toContain("Publish to WordPress (draft)");
  });

  it("falls back to a fixed text for a failure without a stored message", () => {
    const markup = html(
      status({ change: article({ status: "FAILED", canDecide: false, error: null }) }),
    );
    expect(markup).toContain("Something went wrong. Nothing more was changed.");
  });

  it("shows an undone draft and lets it be sent again", () => {
    const markup = html(
      status({
        canPropose: true,
        change: article({ status: "UNDONE", statusLabel: "Undone", canDecide: false }),
      }),
    );
    expect(markup).toContain("Undone. The draft is in the WordPress Trash.");
    expect(markup).toContain("Publish to WordPress (draft)");
  });

  it("uses the compact size on request", () => {
    expect(html(status(), true, true)).toContain("text-xs");
    expect(html(status(), true, false)).toContain("text-sm");
  });
});

describe("PublishToWordPress", () => {
  it("renders nothing before the status arrives and makes no request", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const markup = renderToStaticMarkup(
        createElement(PublishToWordPress, {
          projectId: "project-1",
          creativeId: "creative-1",
          isManager: true,
        }),
      );
      expect(markup).toBe("");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("polls every 4 seconds for at most 3 minutes with no-store and clears the interval", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/components/seo-apply/publish-to-wordpress.tsx"),
      "utf8",
    );
    expect(source).toContain("POLL_MS = 4_000");
    expect(source).toContain("POLL_MAX_MS = 3 * 60_000");
    expect(source).toContain('cache: "no-store"');
    expect(source).toContain("clearInterval(timer)");
    expect(source).toContain("alive.current = false");
  });
});
