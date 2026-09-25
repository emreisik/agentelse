"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

const STORAGE_KEY = "agentelse:workspace-right-panel:collapsed";
const DESKTOP_QUERY = "(min-width: 1024px)";

export type WorkspacePanelTabKey = "brand" | "files" | "outputs" | "calendar";

// Shared open/closed state for the Brand Workspace right panel — the header's
// "•••" button (workspace-top-bar.tsx) and the panel itself
// (workspace-right-panel.tsx) are siblings in the tree (the header sits
// above the row that holds the panel), so a plain prop can't connect them;
// this Context is the smallest thing that can. Responsive default (open on
// desktop >=1024px, closed below it) comes from a live matchMedia
// subscription; a manual toggle this session overrides it until the next
// page load, and is remembered via localStorage.
//
// requestedTab/openTab: a THIRD sibling — the conversation column's Work
// Summary Strip (project-chat.tsx) — needs to open the panel to a specific
// tab (spec: "ready → Outputs, waiting → Outputs filtered to review,
// approved → approved outputs or Calendar"). openTab() both ensures the
// panel is open (never collapses an already-open one, unlike toggle()) and
// records which tab was asked for; WorkspaceRightPanel consumes it once
// (via consumeRequestedTab) so a later manual tab click isn't overridden
// back on a re-render.
type PanelToggleState = {
  collapsed: boolean;
  toggle: () => void;
  isDesktop: boolean;
  requestedTab: WorkspacePanelTabKey | null;
  openTab: (tab: WorkspacePanelTabKey) => void;
  consumeRequestedTab: () => void;
};

const WorkspacePanelToggleContext = createContext<PanelToggleState | null>(
  null,
);

// Same SSR-safe useSyncExternalStore shape as workspace-right-panel.tsx's
// original useStoredCollapsed / theme-toggle.tsx's useMounted: the server
// (and the client's first hydration pass, which must match it) always sees
// the getServerSnapshot value, then React re-syncs to the real live value
// right after — no hydration-mismatch warning, no setState-in-effect.
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(DESKTOP_QUERY);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

function useStoredOverride(): boolean | null {
  return useSyncExternalStore(
    () => () => {},
    () => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === "1") return true;
        if (stored === "0") return false;
        return null;
      } catch {
        return null;
      }
    },
    () => null,
  );
}

export function WorkspacePanelToggleProvider({
  children,
}: {
  children: ReactNode;
}) {
  const isDesktop = useIsDesktop();
  const storedOverride = useStoredOverride();
  // null = "no toggle click yet this render" — falls back to the stored
  // preference, which itself falls back to the responsive default below.
  const [sessionOverride, setSessionOverride] = useState<boolean | null>(null);
  const override = sessionOverride ?? storedOverride;
  const collapsed = override ?? !isDesktop;
  const [requestedTab, setRequestedTab] = useState<WorkspacePanelTabKey | null>(
    null,
  );

  const toggle = useCallback(() => {
    setSessionOverride((current) => {
      const currentCollapsed = current ?? storedOverride ?? !isDesktop;
      const next = !currentCollapsed;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Private-window/storage-denied — collapse state just won't persist.
      }
      return next;
    });
  }, [storedOverride, isDesktop]);

  const openTab = useCallback((tab: WorkspacePanelTabKey) => {
    setSessionOverride(false);
    try {
      localStorage.setItem(STORAGE_KEY, "0");
    } catch {
      // Private-window/storage-denied — collapse state just won't persist.
    }
    setRequestedTab(tab);
  }, []);

  const consumeRequestedTab = useCallback(() => setRequestedTab(null), []);

  const value = useMemo(
    () => ({
      collapsed,
      toggle,
      isDesktop,
      requestedTab,
      openTab,
      consumeRequestedTab,
    }),
    [collapsed, toggle, isDesktop, requestedTab, openTab, consumeRequestedTab],
  );

  return (
    <WorkspacePanelToggleContext.Provider value={value}>
      {children}
    </WorkspacePanelToggleContext.Provider>
  );
}

export function useWorkspacePanelToggle(): PanelToggleState {
  const ctx = useContext(WorkspacePanelToggleContext);
  if (!ctx) {
    throw new Error(
      "useWorkspacePanelToggle must be used inside a WorkspacePanelToggleProvider",
    );
  }
  return ctx;
}
