"use client";

import {
  CalendarClock,
  ChevronRight,
  FileText,
  Layers,
  Lightbulb,
  Megaphone,
  Route,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";

import { WsStatusPill } from "@/components/commands/ws-event-card";
import { useWorkspaceDetail } from "@/components/workspace/workspace-panel-toggle";
import {
  DETAIL_PANE_ID,
  type CompactCardSpec,
  type CompactIcon,
} from "@/lib/works/compact-card";
import { cn } from "@/lib/utils";

// A long card of the chat as ONE compact card, like ChatGPT's canvas cards
// (docs/works.md): icon, title, one line about what is inside and a status.
// Tapping it opens the whole card in the pane on the right, which scrolls on its
// own. Where the page has no pane (any page but the project's chat) the card is
// simply shown in full, as before.

const ICONS: Record<CompactIcon, LucideIcon> = {
  directions: Route,
  ideas: Lightbulb,
  master: FileText,
  plan: CalendarClock,
  package: Layers,
  ads: Megaphone,
};

export function CompactCardView({
  spec,
  open,
  onOpen,
  buttonRef,
}: {
  spec: CompactCardSpec;
  // Its full card is the one open in the pane.
  open: boolean;
  onOpen: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  const Icon = ICONS[spec.icon];
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onOpen}
      aria-expanded={open}
      // The region exists only while a card is open.
      aria-controls={open ? DETAIL_PANE_ID : undefined}
      data-card-compact
      className={cn(
        "mt-1 flex w-full max-w-md items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        open ? "bg-[var(--ws-hover)]" : "hover:bg-[var(--ws-hover)]",
      )}
      style={{
        borderColor: open ? "var(--ws-text-3)" : "var(--ws-border)",
        background: open ? undefined : "var(--ws-surface)",
        boxShadow: "var(--ws-card-shadow)",
      }}
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-xl"
        style={{ background: "var(--ws-hover)" }}
      >
        <Icon
          aria-hidden="true"
          className="size-4"
          style={{ color: "var(--ws-text)" }}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-sm font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          {spec.title}
        </span>
        <span
          className="block truncate text-xs"
          style={{ color: "var(--ws-text-2)" }}
        >
          {spec.subtitle}
        </span>
      </span>
      {spec.status ? (
        <WsStatusPill
          label={spec.status.label}
          tone={spec.status.tone}
          className="max-sm:hidden"
        />
      ) : null}
      <ChevronRight
        aria-hidden="true"
        className="size-4 shrink-0"
        style={{ color: "var(--ws-text-3)" }}
      />
    </button>
  );
}

// What the compact card needs of the pane (the panel's context): null where the
// page has no pane.
export type PaneContext = {
  detail: { id: string; title: string } | null;
  detailContainer: HTMLElement | null;
  openDetail: (id: string, title: string) => void;
};

// The compact card in the chat plus, while it is the open one, its full card in
// the pane. The full card is rendered by a portal from HERE, so it stays inside
// the chat's providers: its buttons send messages, run card actions and read the
// Work exactly as in the chat. Without a pane the card is shown in full.
export function PaneCardView({
  pane,
  cardId,
  spec,
  children,
  buttonRef,
}: {
  pane: PaneContext | null;
  cardId: string;
  spec: CompactCardSpec;
  children?: React.ReactNode;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  if (!pane) return <>{children}</>;
  const open = pane.detail?.id === cardId;
  return (
    <>
      <CompactCardView
        spec={spec}
        open={open}
        onOpen={() => pane.openDetail(cardId, spec.title)}
        buttonRef={buttonRef}
      />
      {open && pane.detailContainer
        ? createPortal(children, pane.detailContainer)
        : null}
    </>
  );
}

// `cardId` is the card's Command: a card that changes in place (directions ->
// plan) keeps it, so an open pane follows the card instead of closing.
export function PaneCard({
  cardId,
  spec,
  children,
}: {
  cardId: string;
  spec: CompactCardSpec;
  children?: React.ReactNode;
}) {
  const pane = useWorkspaceDetail();
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const registerCard = pane?.registerCard;
  const openDetail = pane?.openDetail;
  const open = pane?.detail?.id === cardId;
  const closedEverywhere = pane ? pane.detail === null : false;

  // In the chat while it is mounted: the pane says so when its card has gone.
  React.useEffect(() => registerCard?.(cardId), [registerCard, cardId]);

  // The pane's title follows the card: it changes in place.
  React.useEffect(() => {
    if (open) openDetail?.(cardId, spec.title);
  }, [open, openDetail, cardId, spec.title]);

  // Focus goes back to the compact card when the pane is closed (not when
  // another card takes the pane over: that one has the focus).
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (wasOpen.current && !open && closedEverywhere) {
      buttonRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open, closedEverywhere]);

  return (
    <PaneCardView
      pane={pane}
      cardId={cardId}
      spec={spec}
      buttonRef={buttonRef}
    >
      {children}
    </PaneCardView>
  );
}
