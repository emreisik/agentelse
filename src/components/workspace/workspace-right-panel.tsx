"use client";

import { useState, type ReactNode } from "react";
import {
  BookOpen,
  CalendarDays,
  Layers,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
} from "lucide-react";

import { Button } from "@/components/ui/button";
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
  "h-auto flex-none rounded-[6px] border-none px-3 py-2 text-[11px] font-medium shadow-none";

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
        className="flex h-[55px] shrink-0 items-center justify-between border-b px-3"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <TabsList className="w-fit gap-1 bg-transparent p-0">
          <TabsTrigger
            value="brand"
            className={TAB_TRIGGER_CLASS}
            style={tabStyle("brand")}
          >
            <BookOpen className="size-3.5" />
            Marka
          </TabsTrigger>
          <TabsTrigger
            value="files"
            className={TAB_TRIGGER_CLASS}
            style={tabStyle("files")}
          >
            <Paperclip className="size-3.5" />
            Dosyalar
          </TabsTrigger>
          <TabsTrigger
            value="outputs"
            className={TAB_TRIGGER_CLASS}
            style={tabStyle("outputs")}
          >
            <Layers className="size-3.5" />
            Çıktılar
          </TabsTrigger>
          <TabsTrigger
            value="calendar"
            className={TAB_TRIGGER_CLASS}
            style={tabStyle("calendar")}
          >
            <CalendarDays className="size-3.5" />
            Takvim
          </TabsTrigger>
        </TabsList>
        {isDesktop ? (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Paneli daralt"
            onClick={toggle}
          >
            <PanelRightClose className="size-4" />
          </Button>
        ) : null}
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
  // narrower — same Sheet primitive WorkspaceNavSheet already uses for the
  // left nav on the same screen.
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
          <SheetTitle className="sr-only">Çalışma alanı paneli</SheetTitle>
          {tabs}
        </SheetContent>
      </Sheet>
    );
  }

  if (collapsed) {
    return (
      <div
        className="flex w-10 shrink-0 flex-col items-center border-l py-3"
        style={{
          borderColor: "var(--ws-border)",
          background: "var(--ws-surface)",
        }}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          title="Paneli aç"
          onClick={toggle}
        >
          <PanelRightOpen className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <aside
      className="flex w-[367px] shrink-0 flex-col overflow-hidden border-l 2xl:w-[390px]"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
      }}
    >
      {tabs}
    </aside>
  );
}
