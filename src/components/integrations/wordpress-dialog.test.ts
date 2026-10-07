import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WordPressConnectionView } from "@/lib/seo/apply/view-types";

// Bu dosyanın kanıtladığı: WordPress penceresi bağlı / bağlı değil / sınırlı /
// kapsam dışı durumlarını çizer, "değişiklik yalnız onaydan sonra" metnini,
// Editor önerisini ve yönetici uyarısını gösterir, yalnız yöneticilere
// Disconnect / yeniden denetle / günlük sınır çıkar ve şifre hiçbir yerde yazılmaz.

// Gerçek EntityDialog içeriği portala çizer (statik çıktıda görünmez): burada
// başlığı ve gövdeyi satır içi çizen sade bir karşılık kullanılır.
vi.mock("@/components/shared/entity-dialog", async () => {
  const { createElement: h } = await import("react");
  return {
    EntityDialog: (props: { header?: React.ReactNode; children: React.ReactNode }) =>
      h("div", null, props.header, props.children),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/server/actions/seo-apply-actions", () => ({
  saveApplySettingsAction: vi.fn(),
}));
vi.mock("@/server/actions/wordpress-actions", () => ({
  connectWordPressAction: vi.fn(),
  testWordPressAction: vi.fn(),
  disconnectWordPressAction: vi.fn(),
}));

const { WordPressDialog } = await import("./wordpress-dialog");
const { WordPressTile } = await import("./wordpress-tile");

const CONNECTED: WordPressConnectionView = {
  connected: true,
  siteId: "site-1",
  origin: "https://example.com",
  host: "example.com",
  accountLabel: "agentelse @ example.com",
  health: "OK",
  healthLabel: "Connected",
  healthReason: null,
  seoPlugin: "YOAST",
  descriptionWritable: true,
  capabilities: {
    draftPosts: true,
    publishPosts: true,
    editPublishedPosts: true,
    editPages: true,
    editPublishedPages: true,
    editOthers: false,
    deletePosts: true,
  },
  lastCheckedAt: "2026-10-07T10:00:00.000Z",
  canManage: true,
  adminWarning: false,
  canRebind: false,
};

const NOT_CONNECTED: WordPressConnectionView = {
  connected: false,
  siteId: null,
  origin: null,
  host: null,
  accountLabel: null,
  health: "UNKNOWN",
  healthLabel: "Not checked yet",
  healthReason: null,
  seoPlugin: "NONE",
  descriptionWritable: false,
  capabilities: null,
  lastCheckedAt: null,
  canManage: true,
  adminWarning: false,
  canRebind: false,
};

const render = (
  view: WordPressConnectionView | null,
  extra: Partial<{
    settings: { dailyLimit: number } | null;
    error: string | null;
    indexNowSlot: string;
  }> = {},
) =>
  renderToStaticMarkup(
    createElement(WordPressDialog, {
      projectId: "proj-1",
      view,
      closeHref: "/projects/proj-1/integrations",
      settings: { dailyLimit: 10 },
      ...extra,
    }),
  );

const NOTICE =
  "Agentelse changes your site only after an owner or admin approves each change. New articles are saved as drafts.";

describe("WordPressDialog", () => {
  it("bağlı değilken bağlantı formunu, Editor önerisini ve yardım yolunu gösterir", () => {
    const html = render(NOT_CONNECTED);
    expect(html).toContain("Not connected yet");
    expect(html).toContain(NOTICE);
    expect(html).toContain("Use a dedicated WordPress user with the Editor role.");
    expect(html).toContain("Users &gt; Profile &gt; Application Passwords");
    expect(html).toContain('name="siteUrl"');
    expect(html).toContain('name="username"');
    expect(html).toContain('type="password"');
    expect(html).toContain('name="appPassword"');
    expect(html).not.toContain("Disconnect");
  });

  it("görünüm yokken de (null) bağlantı formunu çizmez ve çökmez", () => {
    const html = render(null);
    expect(html).toContain("Not connected yet");
    expect(html).toContain("Ask a workspace owner or admin to connect WordPress.");
    expect(html).not.toContain('name="appPassword"');
  });

  it("yönetici olmayan üye bağlanamaz, yalnız sınayabilir", () => {
    const html = render({ ...CONNECTED, canManage: false });
    expect(html).toContain(">Test<");
    expect(html).not.toContain("Disconnect");
    expect(html).not.toContain('name="appPassword"');
    expect(html).not.toContain("Changes per day");
  });

  it("bağlıyken sağlığı, eklentiyi, yetki çiplerini ve düğmeleri gösterir", () => {
    const html = render(CONNECTED);
    expect(html).toContain("example.com");
    expect(html).toContain("agentelse @ example.com");
    expect(html).toContain("Connected");
    expect(html).toContain("Yoast SEO");
    expect(html).toContain("Create drafts");
    expect(html).toContain("Publish");
    expect(html).toContain("Edit others&#x27; content");
    expect(html).toContain(">Test<");
    expect(html).toContain("Disconnect");
    expect(html).toContain("Changes per day");
    expect(html).not.toContain("Re-check the site");
    expect(html).not.toContain("administrator");
  });

  it("sınırlı bağlantıda neden metnini, çipleri ve meta açıklama notunu gösterir", () => {
    const html = render({
      ...CONNECTED,
      health: "LIMITED",
      healthLabel: "Connected, with limits",
      healthReason: "This WordPress user can make some changes but not all of them.",
      seoPlugin: "YOAST",
      descriptionWritable: false,
    });
    expect(html).toContain("Connected, with limits");
    expect(html).toContain("can make some changes but not all of them");
    expect(html).toContain("Meta descriptions cannot be changed with this setup.");
  });

  it("kapsam dışı durumda yeniden denetle düğmesi yalnız yöneticide çıkar", () => {
    const mismatch: WordPressConnectionView = {
      ...CONNECTED,
      health: "DOMAIN_MISMATCH",
      healthLabel: "Outside the verified site",
      healthReason:
        "The site you verified on the Search page changed. Re-check the connection in the WordPress settings.",
      canRebind: true,
    };
    const manager = render(mismatch);
    expect(manager).toContain("Outside the verified site");
    expect(manager).toContain("Re-check the site");
    expect(manager).toContain('name="rebind"');
    expect(render({ ...mismatch, canManage: false })).not.toContain("Re-check the site");
  });

  it("yönetici hesabı uyarısı yalnız adminWarning varken görünür", () => {
    const warning =
      "This account is an administrator. An Application Password can do everything its user can. Create an Editor user for Agentelse instead.";
    expect(render({ ...CONNECTED, adminWarning: true })).toContain(warning);
    expect(render(CONNECTED)).not.toContain(warning);
  });

  it("şifre reddedildiyse yeniden bağlanma formu açık gelir", () => {
    const html = render({ ...CONNECTED, health: "AUTH", healthLabel: "Password not accepted" });
    expect(html).toContain("Password not accepted");
    expect(html).toMatch(/<details[^>]*open/);
    expect(html).toContain("Connect again");
  });

  it("günlük sınır seçicisi geçerli değeri seçili sunar ve ayar yoksa çıkmaz", () => {
    const html = render(CONNECTED, { settings: { dailyLimit: 7 } });
    expect(html).toContain('name="dailyLimit"');
    expect(html).toMatch(/<option value="7"[^>]*>7<\/option>/);
    expect(render(CONNECTED, { settings: null })).not.toContain("Changes per day");
  });

  it("hata, IndexNow yuvası ve şifre: hata çizilir, yuva yalnız bağlıyken, şifre hiç yazılmaz", () => {
    expect(render(NOT_CONNECTED, { error: "Something went wrong." })).toContain("Something went wrong.");
    expect(render(CONNECTED, { indexNowSlot: "INDEXNOW-SLOT" })).toContain("INDEXNOW-SLOT");
    expect(render(NOT_CONNECTED, { indexNowSlot: "INDEXNOW-SLOT" })).not.toContain("INDEXNOW-SLOT");
    const html = render(CONNECTED);
    expect(html).not.toMatch(/value="[A-Za-z0-9]{24}"/);
  });
});

describe("WordPressTile", () => {
  it("görünüm yokken (bayrak kapalı) hiçbir şey çizmez", () => {
    expect(
      renderToStaticMarkup(
        createElement(WordPressTile, { base: "/projects/p/integrations", kategori: undefined, view: null }),
      ),
    ).toBe("");
  });

  it("bağlı değilken ve bağlıyken doğru bağlantıyı ve etiketi gösterir", () => {
    const tile = (view: WordPressConnectionView, kategori?: string) =>
      renderToStaticMarkup(
        createElement(WordPressTile, { base: "/projects/p/integrations", kategori, view }),
      );
    const off = tile(NOT_CONNECTED, "analitik");
    expect(off).toContain("Not connected");
    expect(off).toContain("integration=wordpress");
    expect(off).toContain("kategori=analitik");
    const on = tile(CONNECTED);
    expect(on).toContain("example.com");
    expect(on).toContain("Connected");
    expect(on).not.toContain("kategori=");
  });
});
