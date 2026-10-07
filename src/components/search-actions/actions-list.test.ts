import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  SeoActionItem,
  SeoActionsPanel,
} from "@/server/seo/actions/panel";

// Bu dosyanın kanıtladığı (SC-F6 "Actions & results" görünümü): sonuç satırında
// "Worked: +18% CTR" başlığı ve ayrıntısı; düğmeler yalnız can bayrakları izin
// verdiğinde çıkar ve gizli projectId/actionId taşır; vurgulanan satır halkalı
// ve açık; boş durum ve Search Console bağlı değil notu; sorgu dizesi ya da
// anahtar kelime hiçbir yerde çizilmez.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/seo-action-actions", () => ({
  markActionAppliedAction: vi.fn(),
  undoActionAppliedAction: vi.fn(),
  dismissActionAction: vi.fn(),
  confirmActionLiveAction: vi.fn(),
  checkActionNowAction: vi.fn(),
}));

const { ActionsListView } = await import("./actions-list");

function item(overrides: Partial<SeoActionItem> = {}): SeoActionItem {
  return {
    id: "act-1",
    kind: "TITLE_META",
    kindLabel: "Title and description",
    status: "ACCEPTED",
    statusLabel: "To do",
    tone: "waiting",
    title: "Title and description · /pricing",
    targetPath: "/pricing",
    proposalLines: [],
    instructions: null,
    checks: [],
    headline: null,
    detail: null,
    note: null,
    ask: null,
    cardHref: null,
    can: {
      apply: false,
      undo: false,
      dismiss: false,
      confirmLive: false,
      checkNow: false,
    },
    highlighted: false,
    ...overrides,
  };
}

function panel(overrides: Partial<SeoActionsPanel> = {}): SeoActionsPanel {
  const needsYou = overrides.needsYou ?? [];
  const inProgress = overrides.inProgress ?? [];
  const results = overrides.results ?? [];
  return {
    projectId: "project-1",
    searchConnected: true,
    needsYou,
    inProgress,
    results,
    counts: {
      needsYou: needsYou.length,
      inProgress: inProgress.length,
      worked: results.filter((r) => r.status === "WORKED").length,
      didnt: results.filter((r) => r.status === "DIDNT").length,
      inconclusive: results.filter((r) => r.status === "INCONCLUSIVE").length,
    },
    ...overrides,
  };
}

const render = (value: SeoActionsPanel) =>
  renderToStaticMarkup(createElement(ActionsListView, { panel: value }));

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("ActionsListView", () => {
  it("shows the title, subtitle and the empty state", () => {
    const plain = text(render(panel()));
    expect(plain).toContain("Actions & results");
    expect(plain).toContain(
      "What you changed on your site and what it did in Google Search.",
    );
    expect(plain).toContain(
      "No changes tracked yet. Use “Fix this” on an opportunity to start.",
    );
    expect(plain).not.toContain("Connect Search Console");
  });

  it("notes a missing search connection", () => {
    const plain = text(render(panel({ searchConnected: false })));
    expect(plain).toContain(
      "Connect Search Console to measure results in search.",
    );
  });

  it("renders a result with its headline and detail", () => {
    const html = render(
      panel({
        results: [
          item({
            id: "act-2",
            status: "WORKED",
            statusLabel: "Worked",
            tone: "positive",
            headline: "Worked: +18% CTR",
            detail:
              "Compared with 6 similar pages · likely between +9% and +27%",
          }),
        ],
      }),
    );
    const plain = text(html);
    expect(plain).toContain("Results");
    expect(plain).toContain("Worked: +18% CTR");
    expect(plain).toContain(
      "Compared with 6 similar pages · likely between +9% and +27%",
    );
    expect(plain).toContain("1 worked");
    expect(html).toContain('id="action-act-2"');
  });

  it("groups needs-you and in-progress items", () => {
    const plain = text(
      render(
        panel({
          needsYou: [item({ id: "a" })],
          inProgress: [
            item({
              id: "b",
              status: "EVALUATING",
              statusLabel: "Measuring",
              note: "Measuring. Results expected around Nov 3.",
            }),
          ],
        }),
      ),
    );
    expect(plain).toContain("Needs you");
    expect(plain).toContain("In progress");
    expect(plain).toContain("1 to do");
    expect(plain).toContain("1 in progress");
    expect(plain).toContain("Measuring. Results expected around Nov 3.");
  });

  it("shows buttons only when the can flags allow them", () => {
    const none = render(panel({ needsYou: [item()] }));
    expect(none).not.toContain("Mark as done");
    expect(none).not.toContain("It&#x27;s live");
    expect(none).not.toContain("Dismiss");

    const all = render(
      panel({
        needsYou: [
          item({
            status: "APPLIED",
            ask: "Did you update this page's title and description?",
            can: {
              apply: true,
              undo: true,
              dismiss: true,
              confirmLive: true,
              checkNow: true,
            },
          }),
        ],
      }),
    );
    const plain = text(all);
    expect(plain).toContain(
      "Did you update this page's title and description?",
    );
    for (const label of [
      "Mark as done",
      "It's live",
      "Not done yet",
      "Check now",
      "Dismiss",
    ]) {
      expect(plain).toContain(label);
    }
    expect(all).toContain('name="projectId" value="project-1"');
    expect(all).toContain('name="actionId" value="act-1"');
  });

  it("links to the SEO Manager card", () => {
    const html = render(
      panel({
        needsYou: [item({ cardHref: "/projects/project-1?work=seofix_act-1" })],
      }),
    );
    expect(html).toContain('href="/projects/project-1?work=seofix_act-1"');
    expect(text(html)).toContain("Open in SEO Manager");
  });

  it("opens the highlighted item and rings it", () => {
    const html = render(
      panel({
        needsYou: [
          item({
            highlighted: true,
            instructions: ["Open the page.", "Publish the change."],
            checks: [{ label: "The title changed", ok: true }],
          }),
        ],
      }),
    );
    expect(html).toContain('data-highlighted="true"');
    expect(html).toContain("ring-2 ring-primary");
    expect(html.match(/<details[^>]*open/g)?.length).toBe(2);
    const plain = text(html);
    expect(plain).toContain("How to do it");
    expect(plain).toContain("What we checked");
    expect(plain).toContain("✓");
    expect(plain).toContain("The title changed");
  });

  it("keeps details closed for other items and marks failed checks", () => {
    const html = render(
      panel({
        needsYou: [
          item({
            instructions: ["Open the page."],
            checks: [{ label: "Title matches", ok: false }],
          }),
        ],
      }),
    );
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(text(html)).toContain("✕");
  });

  it("renders proposal lines as given and nothing from a query string", () => {
    const html = render(
      panel({
        needsYou: [
          item({
            title: "Content refresh · /guide",
            proposalLines: ["Cover: pricing"],
          }),
        ],
      }),
    );
    expect(text(html)).toContain("Cover: pricing");
    expect(html).not.toContain("utm_");
    expect(html).not.toContain("?q=");
  });
});
