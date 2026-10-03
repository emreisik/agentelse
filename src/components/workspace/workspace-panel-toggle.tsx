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

import { createDetailStore, togglePanel } from "@/lib/works/detail-pane";

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
//
// detail: a long card of the chat shown in full in the same slot, wider than
// the tabs (docs/works.md, src/lib/works/detail-pane.ts). While it is open it
// takes the panel's place whether the panel was collapsed or not; closing it
// returns to the tabs (or to the collapsed state they were in). The card is
// rendered into `detailContainer` by a portal from where it sits in the chat.
type PanelToggleState = {
  collapsed: boolean;
  toggle: () => void;
  isDesktop: boolean;
  requestedTab: WorkspacePanelTabKey | null;
  openTab: (tab: WorkspacePanelTabKey) => void;
  consumeRequestedTab: () => void;
  detail: { id: string; title: string } | null;
  openDetail: (id: string, title: string) => void;
  closeDetail: () => void;
  detailContainer: HTMLElement | null;
  setDetailContainer: (container: HTMLElement | null) => void;
  registerCard: (id: string) => () => void;
  detailPresent: ReadonlySet<string>;
};

const WorkspacePanelToggleContext = createContext<PanelToggleState | null>(
  null,
);

// Same SSR-safe useSyncExternalStore shape as workspace-right-panel.tsx's
// original useStoredCollapsed: the server
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
  const [detailStore] = useState(() => createDetailStore<HTMLElement>());
  const detailSnapshot = useSyncExternalStore(
    detailStore.subscribe,
    detailStore.getSnapshot,
    detailStore.getSnapshot,
  );

  const toggle = useCallback(() => {
    const detailOpen = detailStore.getSnapshot().detail !== null;
    if (detailOpen) detailStore.close();
    setSessionOverride((current) => {
      const currentCollapsed = current ?? storedOverride ?? !isDesktop;
      const outcome = togglePanel({ detailOpen, collapsed: currentCollapsed });
      try {
        localStorage.setItem(STORAGE_KEY, outcome.collapsed ? "1" : "0");
      } catch {
        // Private-window/storage-denied — collapse state just won't persist.
      }
      return outcome.collapsed;
    });
  }, [storedOverride, isDesktop, detailStore]);

  const openTab = useCallback(
    (tab: WorkspacePanelTabKey) => {
      setSessionOverride(false);
      try {
        localStorage.setItem(STORAGE_KEY, "0");
      } catch {
        // Private-window/storage-denied — collapse state just won't persist.
      }
      // A tab is asked for in the tabs' own slot: an open card gives it back.
      detailStore.close();
      setRequestedTab(tab);
    },
    [detailStore],
  );

  const consumeRequestedTab = useCallback(() => setRequestedTab(null), []);

  const value = useMemo(
    () => ({
      collapsed,
      toggle,
      isDesktop,
      requestedTab,
      openTab,
      consumeRequestedTab,
      detail: detailSnapshot.detail,
      openDetail: detailStore.open,
      closeDetail: detailStore.close,
      detailContainer: detailSnapshot.container,
      setDetailContainer: detailStore.setContainer,
      registerCard: detailStore.register,
      detailPresent: detailSnapshot.present,
    }),
    [
      collapsed,
      toggle,
      isDesktop,
      requestedTab,
      openTab,
      consumeRequestedTab,
      detailSnapshot,
      detailStore,
    ],
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

// The pane on the right for one long card: null where there is no workspace
// panel (any page but the project's chat), so a compact card there simply shows
// its full card in the chat as before.
export function useWorkspaceDetail(): PanelToggleState | null {
  return useContext(WorkspacePanelToggleContext);
}
