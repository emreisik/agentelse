import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Form: alanlar, canEdit false iken devre dışı ve kaydet düğmesi yok, logo
// seçenekleri assetUrl(thumb) kullanır, liste boşken ipucu metni.

vi.mock("@/server/actions/report-share-actions", () => ({
  saveReportBrandingAction: vi.fn(),
}));
// ActionForm useRouter kullanır; burada yalnız form kabuğu gerekir.
vi.mock("@/components/shared/action-form", () => ({
  ActionForm: ({ children }: { children: ReactNode }) =>
    createElement("form", null, children),
}));
vi.mock("@/components/shared/submit-button", () => ({
  SubmitButton: ({ children }: { children: ReactNode }) =>
    createElement("button", { type: "submit" }, children),
}));

import { LOGO_EMPTY_HINT, type BrandingSnapshot } from "@/lib/report-share/types";
import { BrandingForm } from "./branding-form";

const BRANDING: BrandingSnapshot = {
  displayName: "Acme Agency",
  accent: "green",
  footer: "Prepared by Acme.",
  logoAssetId: "logo2",
};

function render(props: {
  logos?: { id: string; filename: string }[];
  canEdit?: boolean;
  branding?: BrandingSnapshot;
}): string {
  return renderToStaticMarkup(
    createElement(BrandingForm, {
      branding: props.branding ?? BRANDING,
      logos: props.logos ?? [],
      canEdit: props.canEdit ?? true,
    }),
  );
}

describe("BrandingForm", () => {
  it("renders the fields with the current values", () => {
    const html = render({});
    expect(html).toContain('name="displayName"');
    expect(html).toContain('value="Acme Agency"');
    expect(html).toContain('maxLength="60"');
    expect(html).toContain('name="footer"');
    expect(html).toContain('value="Prepared by Acme."');
    expect(html).toContain('maxLength="160"');
    expect(html.match(/name="accent"/g)).toHaveLength(6);
    expect(html).toMatch(/name="accent" checked="" value="green"/);
    expect(html).toContain("Save branding");
  });

  it("is disabled and has no save button when the viewer can't edit", () => {
    const html = render({ canEdit: false });
    expect(html).toContain("<fieldset disabled");
    expect(html).not.toContain("Save branding");
    expect(html).toContain("Only workspace owners and admins can change this.");
  });

  it("lists logo options with thumb urls and preselects the current logo", () => {
    const html = render({
      logos: [
        { id: "logo1", filename: "one.png" },
        { id: "logo2", filename: "two.webp" },
      ],
    });
    expect(html).toContain('src="/api/assets/logo1?w=320"');
    expect(html).toContain('src="/api/assets/logo2?w=320"');
    expect(html).toMatch(/name="logoAssetId" checked="" value="logo2"/);
    expect(html).toContain("No logo");
    expect(html).not.toContain(LOGO_EMPTY_HINT);
  });

  it("shows the empty-state hint when there are no logos", () => {
    const html = render({ logos: [] });
    expect(html).toContain(LOGO_EMPTY_HINT.replace("isn't", "isn&#x27;t"));
    expect(html).toContain('name="logoAssetId" value=""');
    expect(html).not.toContain("<img");
  });
});
