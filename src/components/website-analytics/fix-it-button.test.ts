import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { gaEditStartHref } from "@/lib/website-analytics/fixes/consent-copy";
import type { GaFixOffer } from "@/lib/website-analytics/fixes/view-types";

// Bu dosyanın kanıtladığı (GA-F7 "Fix it for me" düğmesi): tam etiket yalnız
// 'available' durumunda; pending/done/needs_access varyantları; olay seçimi
// seçenekleri; 'Allow editing' bağlantısı tam başlangıç adresine gider.

vi.mock("@/server/actions/ga-fix-actions", () => ({
  proposeGaFixAction: vi.fn(),
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

const { FixItButton } = await import("./fix-it-button");
const actions = await import("@/server/actions/ga-fix-actions");
vi.mocked(actions.proposeGaFixAction).mockName("propose");

const LABEL = "Fix it for me (needs approval)";

function offer(patch: Partial<GaFixOffer> = {}): GaFixOffer {
  return {
    id: "offer-1",
    kind: "RETENTION_14M",
    checkKey: "MH14",
    title: "Keep your data longer",
    description: "Raises event data retention to 14 months, after you approve.",
    buttonLabel: LABEL,
    field: null,
    state: "available",
    changeId: null,
    ...patch,
  };
}

const render = (value: GaFixOffer) =>
  renderToStaticMarkup(
    createElement(FixItButton, { projectId: "proj-1", offer: value }),
  );

const renderFor = (value: GaFixOffer, canManage: boolean) =>
  renderToStaticMarkup(
    createElement(FixItButton, { projectId: "proj-1", offer: value, canManage }),
  );

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("FixItButton", () => {
  it("shows the exact label and caption when available", () => {
    const html = render(offer());
    expect(text(html)).toContain(LABEL);
    expect(text(html)).toContain("Raises event data retention to 14 months");
    expect(html).toContain('data-action="propose"');
    expect(html).toContain(
      "Sent for approval. A workspace owner or admin can approve it here or in the chat.",
    );
  });

  it("posts the project, kind and the GUIDE source as hidden fields", () => {
    const html = render(offer());
    expect(html).toContain('name="projectId" value="proj-1"');
    expect(html).toContain('name="kind" value="RETENTION_14M"');
    expect(html).toContain('name="source" value="GUIDE"');
  });

  it("renders no select without a field", () => {
    expect(render(offer())).not.toContain("<select");
  });

  it("renders the event options as a select", () => {
    const html = render(
      offer({
        kind: "KEY_EVENT_CREATE",
        checkKey: "MH5",
        field: {
          name: "eventName",
          label: "Event",
          options: [
            { value: "generate_lead", label: "generate_lead" },
            { value: "whatsapp_click", label: "whatsapp_click" },
          ],
        },
      }),
    );
    expect(html).toContain('<select name="eventName"');
    expect(html).toContain('<option value="generate_lead"');
    expect(html).toContain('<option value="whatsapp_click"');
    expect(text(html)).toContain(LABEL);
  });

  it("shows only a note while waiting for approval", () => {
    const html = render(offer({ state: "pending" }));
    expect(text(html)).toContain("Waiting for approval");
    expect(text(html)).not.toContain(LABEL);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
  });

  it("shows Done without a button", () => {
    const html = render(offer({ state: "done" }));
    expect(text(html)).toContain("Done");
    expect(text(html)).not.toContain(LABEL);
    expect(html).not.toContain("<button");
  });

  it("asks for editing access with a link to the exact start href", () => {
    const html = render(offer({ state: "needs_access" }));
    expect(text(html)).toContain(
      "Agentelse can only read your Google Analytics right now.",
    );
    expect(text(html)).not.toContain(LABEL);
    expect(html).toContain(`href="${gaEditStartHref("proj-1").replace(/&/g, "&amp;")}"`);
    expect(html).toContain("Allow editing");
    expect(html).not.toContain("<form");
  });

  it("shows no link to someone who cannot manage; asks for an owner or admin", () => {
    const html = renderFor(offer({ state: "needs_access" }), false);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Allow editing");
    expect(text(html)).toContain(
      "Ask a workspace owner or admin to allow editing.",
    );
  });
});
