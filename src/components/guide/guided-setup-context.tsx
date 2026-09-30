"use client";

import { createContext, useContext } from "react";

import {
  entryOf,
  type GuidedEntry,
  type GuidedSetupSummary,
} from "@/lib/guided-setup/contract";

// Where an open() call came from (analytics-free: it only decides focus and
// auto-open rules in the shell).
export type GuidedOpenSource =
  | "url"
  | "stream"
  | "welcome"
  | "chip"
  | "menu"
  | "card";

export type GuidedOpenOptions = {
  // The chat message that asked for setup; the server reads the words from it.
  seedCommandId?: string;
};

// What the chat surfaces (welcome card, chip, "+" menu, cards) need from the
// setup sheet. Built by ProjectChat; the sheet itself is a lazy sibling.
export type GuidedSetupApi = {
  isOpen: boolean;
  // Idempotent: opening an open sheet does nothing.
  open: (source: GuidedOpenSource, opts?: GuidedOpenOptions) => void;
  close: () => void;
  // Seeded from the page, then kept live by the shell after saves and apply.
  summary: GuidedSetupSummary;
  entry: GuidedEntry;
  // The agent engine can draft a first plan (the legacy engine cannot).
  canDraftPlan: boolean;
};

// Provided by the project chat when GUIDED_SETUP is on; null anywhere else
// (flag off, idea thread, a card rendered outside the chat).
const GuidedSetupContext = createContext<GuidedSetupApi | null>(null);

export const GuidedSetupProvider = GuidedSetupContext.Provider;

export function useGuidedSetup(): GuidedSetupApi | null {
  return useContext(GuidedSetupContext);
}

// Derives the entry from the summary so callers cannot hand a stale label.
export function buildGuidedSetupApi(input: {
  isOpen: boolean;
  open: GuidedSetupApi["open"];
  close: () => void;
  summary: GuidedSetupSummary;
  canDraftPlan: boolean;
}): GuidedSetupApi {
  return { ...input, entry: entryOf(input.summary) };
}
