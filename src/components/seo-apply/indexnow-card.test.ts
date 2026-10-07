import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { IndexNowView } from "@/lib/seo/apply/view-types";

// Bu dosyanın kanıtladığı (IndexNow kartı): kapalıyken "Switch on IndexNow";
// açıkken anahtar dosyasının adı, içeriği ve adresi talimatta görünür; doğrulanmış
// ve doğrulanmamış metinleri; düğmeler yalnız yönetici içindir.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/seo-apply-actions", () => ({
  indexNowEnableAction: vi.fn(),
  indexNowVerifyAction: vi.fn(),
  indexNowDisableAction: vi.fn(),
}));

const { IndexNowCard } = await import("./indexnow-card");

const KEY = "0123456789abcdef0123456789abcdef";

function view(overrides: Partial<IndexNowView> = {}): IndexNowView {
  return {
    enabled: true,
    key: KEY,
    keyFileName: `${KEY}.txt`,
    keyUrl: `https://example.com/${KEY}.txt`,
    verified: false,
    lastPingAt: null,
    ...overrides,
  };
}

function html(model: IndexNowView, canManage = true): string {
  return renderToStaticMarkup(
    createElement(IndexNowCard, { projectId: "project-1", view: model, canManage }),
  );
}

describe("IndexNowCard", () => {
  it("offers to switch IndexNow on when it is off", () => {
    const markup = html(
      view({ enabled: false, key: null, keyFileName: null, keyUrl: null }),
    );
    expect(markup).toContain("Switch on IndexNow");
    expect(markup).toContain('name="projectId" value="project-1"');
    expect(markup).toContain("Google does not use it");
    expect(markup).not.toContain("Check the file");
  });

  it("tells a member that an owner or admin switches it on", () => {
    const markup = html(
      view({ enabled: false, key: null, keyFileName: null, keyUrl: null }),
      false,
    );
    expect(markup).not.toContain("Switch on IndexNow");
    expect(markup).toContain("An owner or admin can switch this on.");
  });

  it("shows the key file name, its content and its address", () => {
    const markup = html(view());
    expect(markup).toContain(`${KEY}.txt`);
    expect(markup).toContain(`https://example.com/${KEY}.txt`);
    expect(markup).toContain("The only thing in the file is this key");
    expect(markup).toContain("Check the file");
    expect(markup).toContain("Switch off");
    expect(markup).toContain("Nothing is sent until the key file is in place.");
  });

  it("shows the verified state and the last send date", () => {
    const markup = html(
      view({ verified: true, lastPingAt: "2026-10-05T09:30:00.000Z" }),
    );
    expect(markup).toContain("The key file is in place.");
    expect(markup).toContain("Last sent 2026-10-05");
    expect(markup).not.toContain("Nothing is sent until");
  });

  it("hides the buttons from members", () => {
    const markup = html(view(), false);
    expect(markup).toContain(`${KEY}.txt`);
    expect(markup).not.toContain("Check the file</button>");
    expect(markup).not.toContain("Switch off");
  });
});
