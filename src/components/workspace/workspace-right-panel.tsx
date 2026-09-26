"use client";

import { useState, type ReactNode } from "react";
import { BookOpen, CalendarDays, Layers, Paperclip } from "lucide-react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useWorkspacePanelToggle,
  type WorkspacePanelTabKey,
} from "@/components/workspace/workspace-panel-toggle";
import { AutopilotCard } from "@/components/workspace/autopilot-card";
import type { WorkspaceAutopilotMode } from "@/components/workspace/workspace-right-panel-data";

type TabKey = WorkspacePanelTabKey;

const TAB_TRIGGER_CLASS =
  "h-auto flex-none rounded-[6px] border-none px-2.5 py-1.5 text-[10.5px] font-medium shadow-none";

export function WorkspaceRightPanel({
  projectId,
  autopilotMode,
  brand,
  files,
  outputs,
  calendar,
}: {
  projectId: string;
  autopilotMode: WorkspaceAutopilotMode;
  brand: ReactNode;
  files: ReactNode;
  outputs: ReactNode;
  calendar: ReactNode;
}) {
  const { collapsed, toggle, isDesktop, requestedTab, consumeRequestedTab } =
    useWorkspacePanelToggle();
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
      {/* Fixed at the bottom of the panel, below the scrollable tab body —
          spec: "Keep a compact Autopilot card fixed at the bottom of the
          right panel", same across all four tabs since it reads the one
          project-wide AutonomyPolicy, not a per-tab setting. */}
      <div
        className="shrink-0 border-t p-3"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <AutopilotCard projectId={projectId} autopilotMode={autopilotMode} />
      </div>
    </Tabs>
  );

  // Below the 1024px breakpoint the panel is a right-side drawer (opened by
  // the header's toggle button) instead of pushing the conversation column
  // narrower.
  if (!isDesktop) {
    return (
      <Sheet
        open={!collapsed}
        onOpenChange={(open) => open === collapsed && toggle()}
      >
        <SheetContent
          side="right"
          className="flex w-[390px] max-w-[90vw] flex-col gap-0 p-0"
          style={{ background: "var(--ws-surface)" }}
        >
          <SheetTitle className="sr-only">Workspace panel</SheetTitle>
          {tabs}
        </SheetContent>
      </Sheet>
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
