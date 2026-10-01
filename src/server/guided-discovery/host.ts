import "server-only";

import type { DiscoveryView } from "@/lib/guided-discovery/contract";
import { isGuidedSetupEnabled } from "@/server/guided-setup/flag";

import { readDiscoveryState, type DiscoveryState } from "./service";

// What the project page passes to ProjectChat for the discovery sheet. NEVER
// throws: when anything fails the feature is absent for that request instead of
// taking the chat down through the route's error boundary. Reads only: no
// write, no paid call.

export type DiscoveryHost = {
  // The page was opened with ?guide=setup.
  requested: boolean;
  // null: nothing was started for this project yet.
  view: DiscoveryView | null;
  brandName: string;
};

export type HostDeps = {
  enabled: () => boolean;
  read: (projectId: string) => Promise<DiscoveryState | null>;
};

const defaults: HostDeps = {
  enabled: isGuidedSetupEnabled,
  read: (projectId) => readDiscoveryState(projectId),
};

export async function loadDiscoveryHost(
  projectId: string,
  requested: boolean,
  deps: HostDeps = defaults,
): Promise<DiscoveryHost | undefined> {
  try {
    if (!deps.enabled()) return undefined;
    const state = await deps.read(projectId);
    if (!state) return undefined;
    return { requested, view: state.view, brandName: state.brandName };
  } catch (error) {
    console.error(
      "[guided-discovery] host failed, the page renders without the sheet:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}
