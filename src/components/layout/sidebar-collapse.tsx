"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { PanelLeft } from "lucide-react";

import { cn } from "@/lib/utils";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/components/layout/sidebar-item";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// The docked sidebar collapses to an icon rail, like ChatGPT's: the toggle
// sits at the top right of the open sidebar and on top of the rail, ⇧⌘S
// (Ctrl+Shift+S elsewhere) does the same. Only the docked <aside> has this
// context; the mobile drawer has none, so everything in it renders open and
// the toggle is not shown there.

type SidebarCollapse = { collapsed: boolean; toggle: () => void };

const SidebarCollapseContext = createContext<SidebarCollapse | null>(null);

export function useSidebarCollapsed(): boolean {
  return useContext(SidebarCollapseContext)?.collapsed ?? false;
}

const ONE_YEAR = 60 * 60 * 24 * 365;

export function SidebarShell({
  defaultCollapsed,
  children,
}: {
  // From the cookie (app-shell.tsx), so the first paint has the right width.
  defaultCollapsed: boolean;
  children?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const toggle = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COLLAPSED_COOKIE}=${next ? "collapsed" : "open"}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
  }, [collapsed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  return (
    <SidebarCollapseContext.Provider value={{ collapsed, toggle }}>
      <aside
        data-collapsed={collapsed ? "" : undefined}
        className={cn(
          "hidden h-full shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar md:flex",
          collapsed ? "w-14" : "w-64",
        )}
      >
        {children}
      </aside>
    </SidebarCollapseContext.Provider>
  );
}

// Rendered only while the tooltip is open, i.e. on the client.
function ShortcutKbd() {
  const mac =
    typeof navigator !== "undefined" &&
    /Mac|iP(hone|ad)/.test(navigator.platform);
  return (
    <kbd
      data-slot="kbd"
      className="rounded-sm bg-background/20 px-1.5 py-0.5 font-sans text-[11px] font-medium"
    >
      {mac ? "⇧⌘S" : "Ctrl+Shift+S"}
    </kbd>
  );
}

export function SidebarToggleButton() {
  const context = useContext(SidebarCollapseContext);
  if (!context) return null;
  const { collapsed, toggle } = context;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Open sidebar" : "Close sidebar"}
            aria-expanded={!collapsed}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--ws-hover)]"
            style={{ color: "var(--ws-text-2)" }}
          />
        }
      >
        <PanelLeft className="size-[18px]" />
      </TooltipTrigger>
      <TooltipContent side={collapsed ? "right" : "bottom"} sideOffset={6}>
        Toggle sidebar
        <ShortcutKbd />
      </TooltipContent>
    </Tooltip>
  );
}

// In the rail a line is only its icon: the label moves into a tooltip on the
// right. Open, the line already shows its label, so no tooltip.
export function RailTip({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}) {
  const collapsed = useSidebarCollapsed();
  if (!collapsed) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

const noSubscribe = () => () => {};

// The project loading.tsx's docked sidebar, open or as the rail like the real
// one. loading.tsx cannot read cookies() without losing its instant fallback,
// so this reads document.cookie on the client (navigations); a full page load
// shows the open shape until the page lands.
export function DockedSidebarSkeleton() {
  const collapsed = useSyncExternalStore(
    noSubscribe,
    () =>
      document.cookie
        .split("; ")
        .includes(`${SIDEBAR_COLLAPSED_COOKIE}=collapsed`),
    () => false,
  );

  if (collapsed) {
    return (
      <div className="hidden h-full w-14 shrink-0 flex-col items-center gap-2 overflow-hidden border-r border-sidebar-border bg-sidebar px-2 py-3 md:flex">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="size-10 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="hidden h-full w-64 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar md:flex">
      <div className="flex flex-col gap-2 px-3 pt-3 pb-1">
        <div className="flex h-9 items-center pl-2.5">
          <Skeleton className="h-6 w-28" />
        </div>
        <Skeleton className="h-[52px] w-full rounded-xl" />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full rounded-lg" />
        ))}
      </div>
      <div className="border-t border-sidebar-border px-3 py-2.5">
        <Skeleton className="h-11 w-full rounded-lg" />
      </div>
    </div>
  );
}
