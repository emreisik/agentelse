import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { gaEditStartHref } from "@/lib/website-analytics/fixes/consent-copy";
import type {
  GaFixChangeView,
  GaFixesView,
  GaFixOffer,
  GaOutsideChangeView,
} from "@/lib/website-analytics/fixes/view-types";

// Bu dosyanın kanıtladığı (GA-F7 "Changes Agentelse made" paneli): izin
// bandı (verilmiş/verilmemiş, yönetici/değil); duruma göre satırlar; Approve/
// Reject yalnız canDecide ile; Undo ayrıntısı ve saklama uyarısı; 'Already
// there'; 'switched off right now'; Agentelse dışı değişiklik bloğu (Mute
// yalnız canMuteOutside ile); boş durum; not formu alphaEnabled kapalıyken
// yok; çıktıda e-posta, mülk adı ya da rakam yok.

vi.mock("@/server/actions/ga-fix-actions", () => ({
  proposeGaFixAction: vi.fn(),
  decideGaFixAction: vi.fn(),
  undoGaFixAction: vi.fn(),
  turnOffGaEditAccessAction: vi.fn(),
}));
vi.mock("@/server/actions/measurement-health-actions", () => ({
  muteMeasurementAlertAction: vi.fn(),
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

// Seçici istemci bileşeni; burada yalnız forma yazdığı gizli alan görülür.
vi.mock("@/components/ui/date-time-picker", () => ({
  DatePicker: ({
    name,
    defaultValue,
    min,
    max,
  }: {
    name: string;
    defaultValue?: string;
    min?: string;
    max?: string;
  }) =>
    createElement("input", {
      type: "hidden",
      name,
      defaultValue,
      "data-min": min,
      "data-max": max,
    }),
}));

const { GaFixesPanel } = await import("./ga-fixes-panel");
const actions = await import("@/server/actions/ga-fix-actions");
const health = await import("@/server/actions/measurement-health-actions");
vi.mocked(actions.proposeGaFixAction).mockName("propose");
vi.mocked(actions.decideGaFixAction).mockName("decide");
vi.mocked(actions.undoGaFixAction).mockName("undo");
vi.mocked(actions.turnOffGaEditAccessAction).mockName("turnOff");
vi.mocked(health.muteMeasurementAlertAction).mockName("mute");

function change(patch: Partial<GaFixChangeView> = {}): GaFixChangeView {
  return {
    id: "chg-1",
    kind: "RETENTION_14M",
    title: "Keep your data for 14 months",
    status: "VERIFIED",
    statusLabel: "Done and checked",
    source: "GUIDE",
    createdAt: "2026-10-05T10:00:00.000Z",
    resolvedAt: "2026-10-05T10:05:00.000Z",
    expiresAt: null,
    approvalId: "appr-1",
    canDecide: false,
    canUndo: false,
    undoWarning: null,
    noop: false,
    switchedOff: false,
    error: null,
    ...patch,
  };
}

function view(patch: Partial<GaFixesView> = {}): GaFixesView {
  return {
    editAccess: "granted",
    canManage: true,
    alphaEnabled: true,
    canMuteOutside: true,
    upgradeHref: gaEditStartHref("proj-1"),
    changes: [],
    outside: [],
    offers: [],
    annotationDefaultDay: "2026-10-07",
    ...patch,
  };
}

const outsideItem: GaOutsideChangeView = {
  alertId: "alert-1",
  kind: "KEY_EVENT_REMOVED",
  title: "A key event was removed in Google Analytics",
  detail: "generate_lead",
  lastSeenAt: "2026-10-06T08:00:00.000Z",
};

const render = (value: GaFixesView) =>
  renderToStaticMarkup(
    createElement(GaFixesPanel, { projectId: "proj-1", view: value }),
  );

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("GaFixesPanel header and empty state", () => {
  it("renders the section with its title, subtitle and anchor", () => {
    const html = render(view());
    expect(html).toContain('id="changes"');
    expect(text(html)).toContain("Changes Agentelse made");
    expect(text(html)).toContain(
      "Every change needs approval from a workspace owner or admin. You can undo most of them.",
    );
  });

  it("shows the empty state without changes", () => {
    expect(text(render(view()))).toContain(
      "Nothing here yet. When you approve a fix, it shows up here.",
    );
    expect(text(render(view({ changes: [change()] })))).not.toContain(
      "Nothing here yet.",
    );
  });
});

describe("access banner", () => {
  it("shows Allow editing to a manager when not granted", () => {
    const html = render(view({ editAccess: "not_granted" }));
    expect(text(html)).toContain(
      "Agentelse can only read your Google Analytics right now. To let it make changes you approve, allow editing.",
    );
    expect(html).toContain(`href="${gaEditStartHref("proj-1").replace(/&/g, "&amp;")}"`);
    expect(text(html)).not.toContain("Editing allowed");
  });

  it("tells a non-manager to ask an owner or admin", () => {
    const html = render(view({ editAccess: "not_granted", canManage: false }));
    expect(text(html)).toContain(
      "Ask a workspace owner or admin to allow editing.",
    );
    expect(html).not.toContain("<a ");
  });

  it("shows Editing allowed with Turn off editing for a manager", () => {
    const html = render(view());
    expect(text(html)).toContain("Editing allowed");
    expect(text(html)).toContain("Turn off editing");
    expect(html).toContain('data-action="turnOff"');
    expect(text(html)).toContain(
      "Agentelse stops making changes right away. To also remove the permission at Google, remove Agentelse in your Google Account settings (Security, third-party access).",
    );
  });

  it("hides Turn off editing from a non-manager", () => {
    const html = render(view({ canManage: false }));
    expect(text(html)).toContain("Editing allowed");
    expect(text(html)).not.toContain("Turn off editing");
    expect(html).not.toContain('data-action="turnOff"');
  });
});

describe("change rows", () => {
  it("renders title, status chip and the fixed error message", () => {
    const html = text(
      render(
        view({
          changes: [
            change({
              status: "FAILED",
              statusLabel: "Didn't work",
              error: {
                code: "rejected_by_google",
                message: "Google Analytics didn't accept this change. Nothing was changed.",
              },
            }),
          ],
        }),
      ),
    );
    expect(html).toContain("Keep your data for 14 months");
    expect(html).toContain("Didn't work");
    expect(html).toContain(
      "Google Analytics didn't accept this change. Nothing was changed.",
    );
  });

  it("shows Approve and Reject only when the viewer can decide", () => {
    const waiting = change({
      status: "PROPOSED",
      statusLabel: "Waiting for approval",
      canDecide: true,
    });
    const html = render(view({ changes: [waiting] }));
    expect(html).toContain('data-action="decide"');
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="reject"');
    expect(html).toContain('name="changeId" value="chg-1"');
    expect(text(html)).toContain("Approve");
    expect(text(html)).toContain("Reject");

    const locked = render(
      view({ changes: [{ ...waiting, canDecide: false }] }),
    );
    expect(locked).not.toContain('data-action="decide"');
    expect(text(locked)).toContain("Waiting for a workspace owner or admin");
  });

  it("offers Undo in a details block with the retention warning", () => {
    const warning =
      "Going back to a shorter retention period can delete older data.";
    const html = render(
      view({ changes: [change({ canUndo: true, undoWarning: warning })] }),
    );
    expect(html).toContain("<details");
    expect(html).toContain('data-action="undo"');
    expect(text(html)).toContain(warning);
    expect(text(html)).toContain("Undo this change");
  });

  it("shows no Undo for a change that cannot be undone", () => {
    const html = render(view({ changes: [change()] }));
    expect(html).not.toContain('data-action="undo"');
    expect(text(html)).not.toContain("Undo this change");
  });

  it("marks an already satisfied change as Already there", () => {
    expect(
      text(render(view({ changes: [change({ noop: true })] }))),
    ).toContain("Already there");
    expect(text(render(view({ changes: [change()] })))).not.toContain(
      "Already there",
    );
    // Başarısız bir noop satırı 'Already there' demez.
    expect(
      text(
        render(
          view({
            changes: [
              change({ noop: true, status: "FAILED", statusLabel: "Didn't work" }),
            ],
          }),
        ),
      ),
    ).not.toContain("Already there");
  });

  it("says when a kind is switched off right now", () => {
    const html = text(
      render(
        view({
          changes: [
            change({
              status: "APPROVED",
              statusLabel: "Approved, switched off right now",
              switchedOff: true,
            }),
          ],
        }),
      ),
    );
    expect(html).toContain("switched off right now");
    expect(text(render(view({ changes: [change()] })))).not.toContain(
      "switched off right now",
    );
  });

  it("lists at most 30 changes, newest first as given", () => {
    const many = Array.from({ length: 35 }, (_, index) =>
      change({ id: `chg-${index}`, title: `Change number ${index}` }),
    );
    const html = text(render(view({ changes: many })));
    expect(html).toContain("Change number 0");
    expect(html).toContain("Change number 29");
    expect(html).not.toContain("Change number 30");
    expect(html.indexOf("Change number 0")).toBeLessThan(
      html.indexOf("Change number 1 "),
    );
  });
});

describe("suggestions and the note form", () => {
  const standalone: GaFixOffer = {
    id: "offer-ai",
    kind: "CHANNEL_GROUP_AI",
    checkKey: null,
    title: "Group AI assistant visits",
    description: "Adds an AI assistants channel group, after you approve.",
    buttonLabel: "Fix it for me (needs approval)",
    field: null,
    state: "available",
    changeId: null,
  };
  const attached: GaFixOffer = {
    ...standalone,
    id: "offer-mh14",
    kind: "RETENTION_14M",
    checkKey: "MH14",
    title: "Keep your data longer",
  };

  it("renders standalone offers only, not those tied to a check", () => {
    const html = text(render(view({ offers: [standalone, attached] })));
    expect(html).toContain("Group AI assistant visits");
    expect(html).not.toContain("Keep your data longer");
    expect(html).toContain("Fix it for me (needs approval)");
  });

  it("renders the note form with the default day and the date picker field", () => {
    const html = render(view());
    expect(html).toContain('name="kind" value="ANNOTATION_CREATE"');
    expect(html).toContain('name="source" value="PANEL"');
    expect(html).toContain('name="title"');
    expect(html).toContain('maxLength="49"');
    expect(html).toContain('name="day"');
    expect(html).toContain('value="2026-10-07"');
    expect(html).toContain('data-min="2026-09-07"');
    expect(html).toContain('data-max="2026-10-08"');
    // Yerel tarih alanı yok: tek seçici kullanılır.
    expect(html).not.toContain('type="date"');
  });

  it("hides the note form when the alpha switch is off", () => {
    const html = render(view({ alphaEnabled: false }));
    expect(html).not.toContain('name="kind" value="ANNOTATION_CREATE"');
    expect(text(html)).not.toContain("Add a note");
  });
});

describe("changes outside Agentelse", () => {
  it("lists them with a Mute button when allowed", () => {
    const html = render(view({ outside: [outsideItem] }));
    expect(text(html)).toContain(
      "Changed in Google Analytics outside Agentelse",
    );
    expect(text(html)).toContain("A key event was removed in Google Analytics");
    expect(html).toContain('data-action="mute"');
    expect(html).toContain('name="alertId" value="alert-1"');
    expect(text(html)).toContain("Mute 7 days");
  });

  it("hides the Mute button without canMuteOutside", () => {
    const html = render(
      view({ outside: [outsideItem], canMuteOutside: false }),
    );
    expect(text(html)).toContain("A key event was removed");
    expect(html).not.toContain('data-action="mute"');
    expect(text(html)).not.toContain("Mute 7 days");
  });

  it("omits the block when there is nothing outside", () => {
    expect(text(render(view()))).not.toContain("outside Agentelse");
  });
});

describe("privacy", () => {
  it("adds no email, property name or number-like Google data", () => {
    const html = text(
      render(
        view({
          changes: [change(), change({ id: "chg-2", status: "PROPOSED", canDecide: true })],
          outside: [outsideItem],
        }),
      ),
    );
    expect(html).not.toMatch(/\S+@\S+\.\S+/);
    expect(html).not.toMatch(/properties\/\d+/);
    expect(html).not.toMatch(/\b\d{6,}\b/);
    expect(html).not.toMatch(/property name/i);
  });
});
