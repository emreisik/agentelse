"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  useWorkspacePanelToggle,
  type WorkspacePanelTabKey,
} from "@/components/workspace/workspace-panel-toggle";
import {
  PANEL_TABS,
  WorkspaceDock,
} from "@/components/workspace/workspace-dock";
import { COMPACT_COPY, DETAIL_PANE_ID } from "@/lib/works/compact-card";
import { cn } from "@/lib/utils";

// Escape inside the pane closes it (and does not reach anything behind it). Only
// the pane's own DOM counts: a dialog opened from a card is rendered elsewhere in
// the page, but still sits under the pane in React's tree, so its Escape reaches
// this handler too, and must close the dialog only.
export function closeOnEscape(onClose: () => void) {
  return (event: {
    key: string;
    stopPropagation: () => void;
    currentTarget: { contains: (node: never) => boolean };
    target: unknown;
  }) => {
    if (event.key !== "Escape") return;
    if (!event.currentTarget.contains(event.target as never)) return;
    event.stopPropagation();
    onClose();
  };
}

// One long card of the chat, in full, wider than the tabs and scrolling on its
// own (docs/works.md). Not modal: the chat beside it stays usable.
export function DetailPane({
  cardId,
  title,
  gone,
  onClose,
  containerRef,
}: {
  cardId: string;
  title: string;
  // The card is not in the chat any more.
  gone: boolean;
  onClose: () => void;
  containerRef: (element: HTMLDivElement | null) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Focus moves into the pane when it opens or another card takes it over.
  useEffect(() => {
    headingRef.current?.focus();
  }, [cardId]);
  return (
    <div
      id={DETAIL_PANE_ID}
      role="region"
      aria-labelledby={`${DETAIL_PANE_ID}-title`}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={closeOnEscape(onClose)}
    >
      <div
        className="flex h-[46px] shrink-0 items-center gap-2 border-b pr-1.5 pl-3.5"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <h2
          id={`${DETAIL_PANE_ID}-title`}
          ref={headingRef}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate text-sm font-semibold outline-none"
          style={{ color: "var(--ws-text)" }}
        >
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={COMPACT_COPY.paneClose}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      {gone ? (
        <p
          role="status"
          className="px-4 py-6 text-center text-sm"
          style={{ color: "var(--ws-text-2)" }}
        >
          {COMPACT_COPY.paneGone}
        </p>
      ) : null}
      <div
        ref={containerRef}
        data-slot="detail-pane-body"
        className="min-h-0 flex-1 overflow-y-auto p-3"
      />
    </div>
  );
}

type TabKey = WorkspacePanelTabKey;

// What a panel icon of the dock does: opens the panel on its panel (also in
// the place a card took), closes it when that panel is the one on show, as in
// Photoshop's dock, or else just switches to it.
export function dockPanelAction(input: {
  collapsed: boolean;
  detailOpen: boolean;
  current: TabKey;
  picked: TabKey;
}): "open" | "close" | "switch" {
  if (input.collapsed || input.detailOpen) return "open";
  return input.current === input.picked ? "close" : "switch";
}

// Photoshop's panel dock on the chat screen: the dock (workspace-dock.tsx) is
// always at the right edge, and the panel opens beside it on the one its icon
// names. No tab row and no labels of its own: the dock is the panel's tabs, so
// the panel shows only what was asked for, under its name. Below lg the panel
// is a right-side drawer with its own small icon row (the drawer covers the
// dock); on a phone the dock is hidden and the slim bar opens the drawer.
export function WorkspaceRightPanel({
  brand,
  files,
  outputs,
  calendar,
}: {
  brand: ReactNode;
  files: ReactNode;
  outputs: ReactNode;
  calendar: ReactNode;
}) {
  const {
    collapsed,
    toggle,
    isDesktop,
    openTab,
    requestedTab,
    consumeRequestedTab,
    detail,
    closeDetail,
    setDetailContainer,
    detailPresent,
  } = useWorkspacePanelToggle();
  const [localTab, setLocalTab] = useState<TabKey>("brand");
  // The Work Summary Strip (project-chat.tsx) asks for a specific tab via
  // openTab() — derived rather than synced via an effect, so a pending
  // request always wins until the user explicitly changes tabs (see
  // selectTab below, which consumes it then).
  const tab = requestedTab ?? localTab;
  const panels: Record<TabKey, ReactNode> = { brand, files, outputs, calendar };
  const activeLabel =
    PANEL_TABS.find((item) => item.key === tab)?.label ?? "Workspace panel";

  function selectTab(key: TabKey) {
    setLocalTab(key);
    if (requestedTab) consumeRequestedTab();
  }

  function showTab(key: TabKey) {
    const action = dockPanelAction({
      collapsed,
      detailOpen: Boolean(detail),
      current: tab,
      picked: key,
    });
    if (action === "close") {
      toggle();
    } else if (action === "open") {
      setLocalTab(key);
      openTab(key);
    } else {
      selectTab(key);
    }
  }

  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto">{panels[tab]}</div>
  );

  // A long card of the chat opened in full: it takes the panel's place (also
  // when the panel was collapsed), wider than the panel.
  const detailPane = detail ? (
    <DetailPane
      cardId={detail.id}
      title={detail.title}
      gone={!detailPresent.has(detail.id)}
      onClose={closeDetail}
      containerRef={setDetailContainer}
    />
  ) : null;

  const dock = (
    <WorkspaceDock
      activeTab={!collapsed && !detail ? tab : null}
      panelOpen={!collapsed || Boolean(detail)}
      onTogglePanel={toggle}
      onPanel={showTab}
      // Below md the phone's slim bar has the toggle instead.
      className={isDesktop ? undefined : "hidden md:flex"}
    />
  );

  if (!isDesktop) {
    return (
      <>
        {dock}
        <Sheet
          open={detail ? true : !collapsed}
          onOpenChange={(open) => {
            if (detail) {
              if (!open) closeDetail();
              return;
            }
            if (open === collapsed) toggle();
          }}
        >
          <SheetContent
            side="right"
            showCloseButton={!detail}
            className={cn(
              "flex flex-col gap-0 p-0",
              detail
                ? "data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]"
                : "w-[390px] max-w-[90vw]",
            )}
            style={{ background: "var(--ws-surface)" }}
          >
            <SheetTitle className="sr-only">
              {detail ? detail.title : activeLabel}
            </SheetTitle>
            {detailPane ?? (
              <>
                {/* The drawer covers the dock: its own icon row switches. */}
                <div
                  className="flex h-12 shrink-0 items-center gap-1 border-b px-2.5 pr-12"
                  style={{ borderColor: "var(--ws-border)" }}
                >
                  {PANEL_TABS.map(({ key, label, icon: Icon }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => selectTab(key)}
                      aria-label={label}
                      aria-pressed={tab === key}
                      className="flex size-8 items-center justify-center rounded-lg outline-none transition-colors hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
                      style={
                        tab === key
                          ? {
                              background: "var(--ws-soft-green)",
                              color: "var(--ws-accent)",
                            }
                          : { color: "var(--ws-text-2)" }
                      }
                    >
                      <Icon className="size-4" />
                    </button>
                  ))}
                  <span
                    className="ml-1.5 truncate text-xs font-semibold"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {activeLabel}
                  </span>
                </div>
                {body}
              </>
            )}
          </SheetContent>
        </Sheet>
      </>
    );
  }

  // Floating card, not a docked sidebar: margin top and bottom against the
  // viewport and a full rounded border with a soft shadow — it sits ON the
  // --ws-bg canvas, the dock to its right.
  const card = detailPane ? (
    <aside
      className="my-3 flex w-[min(560px,46vw)] shrink-0 flex-col overflow-hidden rounded-2xl border shadow-[0_4px_24px_rgba(52,75,29,0.07)]"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
      }}
    >
      {detailPane}
    </aside>
  ) : collapsed ? null : (
    <aside
      aria-label={activeLabel}
      className="my-3 flex w-[320px] shrink-0 flex-col overflow-hidden rounded-2xl border shadow-[0_4px_24px_rgba(52,75,29,0.07)] 2xl:w-[340px]"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
      }}
    >
      <div
        className="flex h-10 shrink-0 items-center border-b px-3.5"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <h2
          className="truncate text-xs font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          {activeLabel}
        </h2>
      </div>
      {body}
    </aside>
  );

  return (
    <>
      {card}
      {dock}
    </>
  );
}
