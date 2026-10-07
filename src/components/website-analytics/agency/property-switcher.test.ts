import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { GaPropertyChip } from "@/lib/website-analytics/agency/properties";

// Bu dosyanın kanıtladığı: tek mülk ve yönetici değilse hiçbir şey çizilmez;
// birden çok mülkte çipler (href, Extra / 360 rozeti, seçili işareti) çizilir
// ama yönetim formu yoktur; yöneticide Manage bölümü ekleme formu, ekler için
// Make main / Remove formları ve gizli projectId / propertyId alanlarını taşır.

vi.mock("@/server/actions/website-property-actions", () => ({
  addGaPropertyAction: vi.fn().mockName("add"),
  removeGaPropertyAction: vi.fn().mockName("remove"),
  makeGaPropertyMainAction: vi.fn().mockName("makeMain"),
}));
vi.mock("@/components/shared/action-form", () => ({
  ActionForm: ({
    action,
    children,
  }: {
    action: { getMockName?: () => string };
    children: ReactNode;
  }) =>
    createElement(
      "form",
      { "data-action": action?.getMockName?.() ?? "" },
      children,
    ),
}));

const { PropertySwitcher } = await import("./property-switcher");

function chip(partial: Partial<GaPropertyChip> & { linkId: string }): GaPropertyChip {
  return {
    propertyId: "100",
    label: "Main",
    role: "main",
    serviceLevel: null,
    health: "OK",
    selected: false,
    href: "/projects/p1/site",
    ...partial,
  };
}
const MAIN = chip({ linkId: "l1", selected: true });
const EXTRA = chip({
  linkId: "l2",
  propertyId: "200",
  label: "Blog",
  role: "extra",
  serviceLevel: "360",
  href: "/projects/p1/site?property=200",
});

function html(props: Partial<Parameters<typeof PropertySwitcher>[0]>) {
  return renderToStaticMarkup(
    createElement(PropertySwitcher, {
      projectId: "p1",
      chips: [MAIN],
      canManage: false,
      addable: [],
      canAdd: true,
      ...props,
    }),
  );
}

describe("PropertySwitcher", () => {
  it("renders nothing for a single property without manage rights", () => {
    expect(html({})).toBe("");
  });

  it("renders chips with badges for several properties, but no forms for a viewer", () => {
    const out = html({ chips: [MAIN, EXTRA] });
    expect(out).toContain('href="/projects/p1/site"');
    expect(out).toContain('href="/projects/p1/site?property=200"');
    expect(out).toContain("Extra");
    expect(out).toContain("360");
    expect(out).toContain('aria-current="page"');
    expect(out).not.toContain("<form");
    expect(out).not.toContain("Manage");
  });

  it("gives managers the add form and per-extra forms with hidden ids", () => {
    const out = html({
      chips: [MAIN, EXTRA],
      canManage: true,
      addable: [{ propertyId: "300", label: "Shop (Acme)" }],
    });
    expect(out).toContain("Manage");
    expect(out).toContain('data-action="add"');
    expect(out).toContain('value="300"');
    expect(out).toContain("Shop (Acme)");
    expect(out).toContain("Add property");
    expect(out).toContain('data-action="makeMain"');
    expect(out).toContain('data-action="remove"');
    expect(out).toContain("Make main");
    expect(out).toContain("Remove");
    expect(out).toContain('name="projectId" value="p1"');
    expect(out).toContain('name="propertyId" value="200"');
  });

  it("shows managers a single-property project and the limit message", () => {
    const solo = html({ canManage: true, addable: [{ propertyId: "300", label: "Shop" }] });
    expect(solo).toContain("Add property");
    expect(solo).not.toContain("Make main");
    const full = html({ chips: [MAIN, EXTRA], canManage: true, canAdd: false });
    expect(full).toContain("up to 4 extra properties");
    expect(full).not.toContain("Add property");
  });

  it("tells a manager when every accessible property is linked", () => {
    const out = html({ canManage: true, addable: [], canAdd: true });
    expect(out).toContain("already linked");
  });
});
