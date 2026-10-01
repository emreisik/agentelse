"use client";

import { createContext, useContext } from "react";

import {
  discoveryEntryOf,
  type DiscoveryEntry,
} from "@/components/discovery/discovery-entry";
import type { DiscoveryView } from "@/lib/guided-discovery/contract";

export type DiscoveryOpenSource = "url" | "welcome" | "chip" | "menu";

// What the chat surfaces (welcome card, chip, "+" menu) need from the
// discovery sheet. Built by ProjectChat; the sheet itself is a lazy sibling.
export type DiscoveryContextValue = {
  isOpen: boolean;
  // Idempotent: opening an open sheet does nothing.
  open: (source: DiscoveryOpenSource) => void;
  close: () => void;
  view: DiscoveryView | null;
  entry: DiscoveryEntry;
};

// Null anywhere the feature is absent (flag off, idea thread).
const DiscoveryContext = createContext<DiscoveryContextValue | null>(null);

export const DiscoveryProvider = DiscoveryContext.Provider;

export function useDiscovery(): DiscoveryContextValue | null {
  return useContext(DiscoveryContext);
}

// Derives the entry from the view so callers cannot hand a stale label.
export function buildDiscoveryContext(input: {
  isOpen: boolean;
  open: DiscoveryContextValue["open"];
  close: () => void;
  view: DiscoveryView | null;
  brandName: string;
}): DiscoveryContextValue {
  const { brandName, ...rest } = input;
  return { ...rest, entry: discoveryEntryOf(input.view, brandName) };
}
