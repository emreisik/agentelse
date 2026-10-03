"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, CalendarDays, Layers, Paperclip, X } from "lucide-react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useWorkspacePanelToggle,
  type WorkspacePanelTabKey,
} from "@/components/workspace/workspace-panel-toggle";
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

const TAB_TRIGGER_CLASS =
  "h-auto flex-none rounded-[6px] border-none px-2.5 py-1.5 text-[10.5px] font-medium shadow-none";

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
  // handleTabChange below, which consumes it then).
  const tab = requestedTab ?? localTab;

  function handleTabChange(value: string) {
    setLocalTab(value as TabKey);
    if (requestedTab) consumeRequestedTab();
  }

  function tabStyle(key: TabKey): React.CSSProperties {
    return tab === key
      ? { background: "var(--ws-soft-green)", color: "var(--ws-accent)" }
      : { color: "var(--ws-text-2)" };
  }

  const tabs = (
    <Tabs
      value={tab}
      onValueChange={handleTabChange}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        className="flex h-[46px] shrink-0 items-center border-b px-2.5"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <TabsList className="w-fit gap-1 bg-transparent p-0">
          <TabsTrigger
            value="brand"
            className={TAB_TRIGGER_CLASS}
            style={tabStyle("brand")}
          >
            <BookOpen className="size-3.5" />
            Brand
          </TabsTrigger>
          <TabsTrigger
            value="files"
            className={TAB_TRIGGER_CLASS}
            style={tabStyle("files")}
          >
            <Paperclip className="size-3.5" />
            Files
          </TabsTrigger>
          <TabsTrigger
            value="outputs"
            className={TAB_TRIGGER_CLASS}
            style={tabStyle("outputs")}
          >
            <Layers className="size-3.5" />
            Outputs
          </TabsTrigger>
          <TabsTrigger
            value="calendar"
            className={TAB_TRIGGER_CLASS}
            style={tabStyle("calendar")}
          >
            <CalendarDays className="size-3.5" />
            Calendar
          </TabsTrigger>
        </TabsList>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TabsContent value="brand">{brand}</TabsContent>
        <TabsContent value="files">{files}</TabsContent>
        <TabsContent value="outputs">{outputs}</TabsContent>
        <TabsContent value="calendar">{calendar}</TabsContent>
      </div>
    </Tabs>
  );

  // A long card of the chat opened in full: it takes the panel's place (also
  // when the panel was collapsed), wider than the tabs.
  const detailPane = detail ? (
    <DetailPane
      cardId={detail.id}
      title={detail.title}
      gone={!detailPresent.has(detail.id)}
      onClose={closeDetail}
      containerRef={setDetailContainer}
    />
  ) : null;

  // Below the 1024px breakpoint the panel is a right-side drawer (opened by
  // the header's toggle button) instead of pushing the conversation column
  // narrower.
  if (!isDesktop) {
    return (
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
            {detail ? detail.title : "Workspace panel"}
          </SheetTitle>
          {detailPane ?? tabs}
        </SheetContent>
      </Sheet>
    );
  }

  if (detailPane) {
    return (
      <aside
        className="my-3 mr-3 ml-0 flex w-[min(560px,46vw)] shrink-0 flex-col overflow-hidden rounded-2xl border shadow-[0_4px_24px_rgba(52,75,29,0.07)]"
        style={{
          borderColor: "var(--ws-border)",
          background: "var(--ws-surface)",
        }}
      >
        {detailPane}
      </aside>
    );
  }

  // Fully hidden when collapsed — no docked strip, no icon of its own. The
  // header's PanelRight toggle (workspace-top-bar.tsx) is the only way to
  // reopen it, via the shared useWorkspacePanelToggle context.
  if (collapsed) {
    return null;
  }

  // Floating card, not a docked sidebar: margin on every side (including
  // the top/right/bottom against the viewport, and the left against the
  // conversation column) plus a full rounded border and a soft shadow —
  // it sits ON the --ws-bg canvas rather than being flush-mounted to it.
  return (
    <aside
      className="my-3 mr-3 ml-0 flex w-[320px] shrink-0 flex-col overflow-hidden rounded-2xl border shadow-[0_4px_24px_rgba(52,75,29,0.07)] 2xl:w-[340px]"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
      }}
    >
      {tabs}
    </aside>
  );
}
