import "server-only";

import { after } from "next/server";

import { intakeOfferFor } from "@/server/brand/intake-offer";
import { startDiscovery } from "@/server/guided-discovery/flow";

// What the tap on the creation screen's primary button starts, after the project
// exists: the discovery flow (identity scan, site read and, where the paid research is
// open, the brand research). Its jobs run after the response (after()), so the
// person lands in the project at once.
//
// The offer is recomputed here from the server's own facts, never read from the
// form, and it is the same function the screen's note comes from: the promise
// and the action cannot drift. This never throws and never blocks the redirect.
export async function startIntakeAtCreate(input: {
  userId: string;
  workspaceId: string;
  projectId: string;
  brandId: string;
  domain?: string;
}): Promise<void> {
  try {
    const offer = intakeOfferFor(input.workspaceId);
    // Research by name works without a website, so the raw offer decides; the
    // flow itself applies intakeStartsOf against the stored website.
    if (!offer.scan && !offer.research) return;

    // The flow runs the identity scan, the site read and the research as staged
    // jobs; the only scheduler used is after(), here.
    await startDiscovery({
      access: {
        userId: input.userId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        defaultBrandId: input.brandId,
      },
      schedule: (job) => after(job),
      offer,
    });
  } catch (error) {
    console.error(
      "[intake] could not start:",
      error instanceof Error ? error.message : error,
    );
  }
}
