"use client";

import { createContext, useContext } from "react";
import type { DepartmentKey } from "@prisma/client";

import type { LivePlanPiece } from "@/components/commands/package-run";

// One ticked deliverable of a content-package card, as the chat needs it to
// show a live message for it the moment "Create selected" is pressed.
export type PackageRunItem = {
  id: string;
  title: string;
  // Plain-language deliverable name ("SEO article").
  label: string;
  department?: DepartmentKey;
  // Image deliverables show the live render block; text ones a running card.
  image: boolean;
  // The client's format pick for image items (a CreativeContentFormat).
  contentFormat?: string;
};

// Starts the run and resolves when every item has settled. `ok` is false when
// nothing could be started (the card may then be tried again).
type StartContentPackage = (input: {
  commandId: string;
  items: PackageRunItem[];
}) => Promise<{ ok: boolean }>;

// Produces the nearest week of a saved plan's calendar slots. The server picks
// the pieces (plan-run.ts) and announces them, so there is nothing to pass but
// the plan. Same contract as StartContentPackage.
type StartContentPlan = (input: {
  commandId: string;
  // "Make this post": only this post's channels (docs/works.md "Posts").
  postId?: string;
}) => Promise<{ ok: boolean }>;

// A package or plan pressed in this session: still running, or done, and which
// items were ticked (a plan's pieces are only known once the server announces
// them).
export type PackageRun = { phase: "running" | "started"; itemIds: string[] };

type ChatPackage = {
  start: StartContentPackage;
  startPlan: StartContentPlan;
  // The runs pressed in this session, by package/plan (Command) id. Held by the
  // chat, not by the card: assistant-ui keys messages by position, so a card
  // remounts (and would forget it was pressed) whenever the list shifts.
  runs: Readonly<Record<string, PackageRun>>;
  // The pieces of the plan runs pressed in this session, by piece (creative)
  // id, while they are made: the plan's post cards show their progress.
  pieces?: Readonly<Record<string, LivePlanPiece>>;
};

// Provided by the project chat; null anywhere else (a card rendered outside
// the chat cannot run a package).
const ChatPackageContext = createContext<ChatPackage | null>(null);

export const ChatPackageProvider = ChatPackageContext.Provider;

export function useChatPackage(): ChatPackage | null {
  return useContext(ChatPackageContext);
}
