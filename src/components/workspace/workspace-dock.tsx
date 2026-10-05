"use client";

import type { ReactElement } from "react";
import {
  BookOpen,
  CalendarDays,
  FolderOpen,
  Layers,
  PanelRightClose,
  PanelRightOpen,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { WorkspacePanelTabKey } from "@/components/workspace/workspace-panel-toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// The right edge of the chat screen, Photoshop's panel dock: one quiet column
// of icons, no text. On top the panel's own toggle, then its four panels: an
// icon opens the panel on that panel, and the one on show closes it again.

export const PANEL_TABS: {
  key: WorkspacePanelTabKey;
  label: string;
  icon: LucideIcon;
}[] = [
  { key: "brand", label: "Brand", icon: BookOpen },
  { key: "files", label: "Files", icon: FolderOpen },
  { key: "outputs", label: "Outputs", icon: Layers },
  { key: "calendar", label: "Calendar", icon: CalendarDays },
];

export const DOCK_COPY = {
  label: "Workspace dock",
  open: "Open panel",
  close: "Close panel",
} as const;

const DOCK_BUTTON_CLASS =
  "relative flex size-9 shrink-0 items-center justify-center rounded-lg opacity-70 outline-none transition hover:bg-[var(--ws-hover)] hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50";

function DockTip({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="left" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function WorkspaceDock({
  activeTab,
  panelOpen,
  onTogglePanel,
  onPanel,
  className,
}: {
  // The panel on show; null while it is closed or a card has its place.
  activeTab: WorkspacePanelTabKey | null;
  // The panel or a card in its place is on screen.
  panelOpen: boolean;
  onTogglePanel: () => void;
  onPanel: (tab: WorkspacePanelTabKey) => void;
  className?: string;
}) {
  return (
    <nav
      aria-label={DOCK_COPY.label}
      className={cn(
        "flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto py-3",
        className,
      )}
      style={{ color: "var(--ws-text-2)" }}
    >
      <DockTip label={panelOpen ? DOCK_COPY.close : DOCK_COPY.open}>
        <button
          type="button"
          onClick={onTogglePanel}
          aria-label={panelOpen ? DOCK_COPY.close : DOCK_COPY.open}
          aria-expanded={panelOpen}
          className={DOCK_BUTTON_CLASS}
        >
          {panelOpen ? (
            <PanelRightClose className="size-4" />
          ) : (
            <PanelRightOpen className="size-4" />
          )}
        </button>
      </DockTip>
      <div
        aria-hidden
        className="my-1 h-px w-5 shrink-0"
        style={{ background: "var(--ws-border)" }}
      />
      {PANEL_TABS.map(({ key, label, icon: Icon }) => {
        const active = activeTab === key;
        return (
          <DockTip key={key} label={label}>
            <button
              type="button"
              onClick={() => onPanel(key)}
              aria-label={label}
              aria-pressed={active}
              className={cn(DOCK_BUTTON_CLASS, active && "opacity-100")}
              style={
                active
                  ? {
                      background: "var(--ws-soft-green)",
                      color: "var(--ws-accent)",
                    }
                  : undefined
              }
            >
              <Icon className="size-4" />
            </button>
          </DockTip>
        );
      })}
    </nav>
  );
}
