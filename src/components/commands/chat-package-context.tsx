"use client";

import { createContext, useContext } from "react";
import type { DepartmentKey } from "@prisma/client";

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

// A package pressed in this session: still running, or done, and which items
// were ticked.
export type PackageRun = { phase: "running" | "started"; itemIds: string[] };

type ChatPackage = {
  start: StartContentPackage;
  // The runs pressed in this session, by package (Command) id. Held by the
  // chat, not by the card: assistant-ui keys messages by position, so a card
  // remounts (and would forget it was pressed) whenever the list shifts.
  runs: Readonly<Record<string, PackageRun>>;
};

// Provided by the project chat; null anywhere else (a card rendered outside
// the chat cannot run a package).
const ChatPackageContext = createContext<ChatPackage | null>(null);

export const ChatPackageProvider = ChatPackageContext.Provider;

export function useChatPackage(): ChatPackage | null {
  return useContext(ChatPackageContext);
}
