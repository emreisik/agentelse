import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { viewFixtures } from "@/lib/seo/apply/test-support";
import type {
  SeoApplyView,
  SeoChangeView,
  WordPressConnectionView,
} from "@/lib/seo/apply/view-types";

// Bu dosyanın kanıtladığı ("Website changes" listesi): onay/ret yalnız canDecide
// iken, Undo yalnız yönetici ve canUndo iken (yazısı inmiş FAILED dahil), Make
// it live yalnız canMakeLive iken çıkar; düğmeler gizli projectId/changeId taşır;
// hata metni sabittir; bağlı değil ve boş durumlar; bağlantı yalnız https.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/seo-apply-actions", () => ({
  decideSeoChangeAction: vi.fn(),
  proposeMakeLiveAction: vi.fn(),
  saveApplySettingsAction: vi.fn(),
  undoSeoChangeAction: vi.fn(),
}));

const { ChangesListView } = await import("./changes-list");

function connection(
  overrides: Partial<WordPressConnectionView> = {},
): WordPressConnectionView {
  return {
    connected: true,
    siteId: "site_1",
    origin: "https://example.com",
    host: "example.com",
    accountLabel: "agentelse @ example.com",
    health: "OK",
    healthLabel: "Connected",
    healthReason: null,
    seoPlugin: "YOAST",
    descriptionWritable: true,
    capabilities: null,
    lastCheckedAt: null,
    canManage: true,
    adminWarning: false,
    canRebind: false,
    ...overrides,
  };
}

function view(
  changes: SeoChangeView[],
  overrides: Partial<SeoApplyView> = {},
): SeoApplyView {
  return {
    connection: connection(),
    canManage: true,
    dailyLimit: 10,
    usedToday: 3,
    changes,
    indexNow: null,
    ...overrides,
  };
}

function html(model: SeoApplyView): string {
  return renderToStaticMarkup(
    createElement(ChangesListView, { view: model, projectId: "project-1" }),
  );
}

describe("ChangesListView", () => {
  it("shows the empty state and the usage line", () => {
    const markup = html(view([]));
    expect(markup).toContain("Website changes");
    expect(markup).toContain("No website changes yet");
    expect(markup).toContain("3 of 10 changes used in the last 24 hours");
  });

  it("shows a connect link when WordPress is not connected", () => {
    const markup = html(
      view([], { connection: connection({ connected: false, host: null }) }),
    );
    expect(markup).toContain("WordPress is not connected.");
    expect(markup).toContain("Connect WordPress");
    expect(markup).toContain("/projects/project-1/integrations?integration=wordpress");
    expect(markup).not.toContain("Daily limit");
  });

  it("shows Approve and Reject only when the viewer can decide", () => {
    const decide = html(view([viewFixtures.change({ canDecide: true })]));
    expect(decide).toContain("Approve");
    expect(decide).toContain("Reject");
    expect(decide).toContain('name="decision" value="approve"');
    expect(decide).toContain('name="decision" value="reject"');
    expect(decide).toContain('name="projectId" value="project-1"');
    expect(decide).toContain('name="changeId" value="chg_1"');
    expect(decide).toContain("1 waiting for approval");

    const member = html(
      view([viewFixtures.change({ canDecide: false })], { canManage: false }),
    );
    expect(member).not.toContain('name="decision"');
    expect(member).not.toContain("Reject");
  });

  it("shows Undo with its warning for a manager and never for a member", () => {
    const row = viewFixtures.change({
      id: "chg_2",
      kind: "PUBLISH_ARTICLE",
      status: "VERIFIED",
      statusLabel: "Done and checked",
      canDecide: false,
      canUndo: true,
      undoWarning: "Undo moves the draft to the WordPress Trash.",
      draft: true,
      link: "https://example.com/?p=5",
    });
    const manager = html(view([row]));
    expect(manager).toContain("Undo");
    expect(manager).toContain("Undo moves the draft to the WordPress Trash.");
    expect(manager).toContain("Saved as a draft. It is not visible to visitors.");
    expect(manager).toContain("Open the draft");

    const member = html(view([row], { canManage: false }));
    expect(member).not.toContain(">Undo<");
  });

  it("offers Undo on a failed change that was written, with the fixed message", () => {
    const row = viewFixtures.change({
      status: "FAILED",
      statusLabel: "Didn't work",
      canDecide: false,
      canUndo: true,
      error: {
        code: "readback_mismatch",
        message:
          "WordPress accepted the change but showed something different afterwards. Check the page in WordPress, or undo the change here.",
      },
    });
    const markup = html(view([row]));
    expect(markup).toContain("Didn&#x27;t work");
    expect(markup).toContain("showed something different afterwards");
    expect(markup).toContain(">Undo<");
  });

  it("shows Make it live only when the draft can go live", () => {
    const base = {
      kind: "PUBLISH_ARTICLE" as const,
      status: "VERIFIED" as const,
      statusLabel: "Done and checked",
      canDecide: false,
    };
    const yes = html(view([viewFixtures.change({ ...base, canMakeLive: true })]));
    expect(yes).toContain("Make it live (needs approval)");
    const no = html(view([viewFixtures.change({ ...base, canMakeLive: false })]));
    expect(no).not.toContain("Make it live");
  });

  it("explains a no-op and never links to a non-https address", () => {
    const markup = html(
      view([
        viewFixtures.change({
          status: "VERIFIED",
          statusLabel: "Done and checked",
          canDecide: false,
          noop: true,
          link: "javascript:alert(1)",
        }),
      ]),
    );
    expect(markup).toContain("Nothing was changed");
    expect(markup).not.toContain("javascript:alert");
    expect(markup).not.toContain("Open the page");
  });

  it("shows preview rows, the IndexNow state and links the row to an anchor", () => {
    const markup = html(
      view([
        viewFixtures.change({
          id: "chg_9",
          status: "VERIFIED",
          statusLabel: "Done and checked",
          canDecide: false,
          preview: [
            { label: "Before", value: "Old title" },
            { label: "After", value: "New title" },
          ],
          link: "https://example.com/pricing",
          indexNow: "SENT",
        }),
      ]),
    );
    expect(markup).toContain('id="change-chg_9"');
    expect(markup).toContain("Old title");
    expect(markup).toContain("New title");
    expect(markup).toContain("IndexNow: sent");
    expect(markup).toContain('href="https://example.com/pricing"');
  });

  it("lets only managers change the daily limit", () => {
    expect(html(view([]))).toContain('name="dailyLimit"');
    expect(html(view([], { canManage: false }))).not.toContain('name="dailyLimit"');
  });
});
