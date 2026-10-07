import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { gaEditStartHref } from "@/lib/website-analytics/fixes/consent-copy";

// Bu dosyanın kanıtladığı (GA-F7 izin kartı): başlık ve açıklama; izin
// verilmemişken yalnız yönetici 'Allow editing' bağlantısını görür; verilmişken
// 'Editing allowed' ve yönetici için 'Turn off editing' + Google Hesabı notu;
// justGranted onay satırı.

vi.mock("@/server/actions/ga-fix-actions", () => ({
  turnOffGaEditAccessAction: vi.fn(),
}));

vi.mock("@/components/shared/action-form", () => ({
  ActionForm: ({
    action,
    successMessage,
    children,
  }: {
    action: { getMockName?: () => string };
    successMessage?: string;
    children: ReactNode;
  }) =>
    createElement(
      "form",
      {
        "data-success": successMessage,
        "data-action": action?.getMockName?.() ?? "",
      },
      children,
    ),
}));

const { GaEditAccessCard } = await import("./ga-edit-access-card");
const actions = await import("@/server/actions/ga-fix-actions");
vi.mocked(actions.turnOffGaEditAccessAction).mockName("turnOff");

type Props = Parameters<typeof GaEditAccessCard>[0];

const render = (props: Partial<Props> = {}) =>
  renderToStaticMarkup(
    createElement(GaEditAccessCard, {
      projectId: "proj-1",
      state: "not_granted",
      canManage: true,
      ...props,
    }),
  );

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("GaEditAccessCard", () => {
  it("explains the optional permission", () => {
    const html = text(render());
    expect(html).toContain("Let Agentelse make approved changes (optional)");
    expect(html).toContain(
      "Agentelse reads your Google Analytics. If you want, it can also make small fixes in your property, such as marking a key event.",
    );
    expect(html).toContain(
      "Each change still needs approval from a workspace owner or admin, and you can undo most of them.",
    );
  });

  it("offers Allow editing to a manager when not granted", () => {
    const html = render();
    expect(html).toContain(`href="${gaEditStartHref("proj-1").replace(/&/g, "&amp;")}"`);
    expect(text(html)).toContain("Allow editing");
    expect(text(html)).not.toContain("Editing allowed");
    expect(html).not.toContain("<form");
  });

  it("tells a non-manager who can allow editing", () => {
    const html = render({ canManage: false });
    expect(text(html)).toContain(
      "Only workspace owners and admins can allow editing.",
    );
    expect(html).not.toContain("<a ");
  });

  it("shows the granted state with Turn off editing for a manager", () => {
    const html = render({ state: "granted" });
    expect(text(html)).toContain("Editing allowed");
    expect(text(html)).toContain("Turn off editing");
    expect(html).toContain('data-action="turnOff"');
    expect(html).toContain('data-success="Agentelse will not make changes any more."');
    expect(html).toContain('name="projectId" value="proj-1"');
    expect(text(html)).toContain(
      "remove Agentelse in your Google Account settings (Security, third-party access)",
    );
    expect(html).not.toContain("Allow editing");
  });

  it("hides Turn off editing from a non-manager", () => {
    const html = render({ state: "granted", canManage: false });
    expect(text(html)).toContain("Editing allowed");
    expect(text(html)).not.toContain("Turn off editing");
    expect(html).not.toContain("<form");
  });

  it("confirms a fresh grant", () => {
    expect(text(render({ state: "granted", justGranted: true }))).toContain(
      "Editing is allowed now.",
    );
    expect(text(render())).not.toContain("Editing is allowed now.");
  });
});
