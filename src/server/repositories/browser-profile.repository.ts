import "server-only";

import type {
  BrowserProfilePurpose,
  BrowserProfileStatus,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export const BrowserProfileRepository = {
  listForProject(projectId: string) {
    return prisma.browserProfile.findMany({
      where: { projectId },
      orderBy: { name: "asc" },
    });
  },

  findByIdInProject(id: string, projectId: string) {
    return prisma.browserProfile.findFirst({ where: { id, projectId } });
  },

  // The one function that must never be bypassed: resolves a browser profile
  // strictly within `projectId`, so a BityPay execution can never be routed
  // to `biduniq-instagram` even if a bug upstream leaks the wrong slug/id.
  findByPurposeInProject(
    projectId: string,
    purpose: BrowserProfilePurpose,
  ) {
    return prisma.browserProfile.findFirst({ where: { projectId, purpose } });
  },

  create(input: {
    workspaceId: string;
    projectId: string;
    brandId: string;
    name: string;
    slug: string;
    purpose: BrowserProfilePurpose;
    status?: BrowserProfileStatus;
  }) {
    const { status = "READY", ...rest } = input;
    return prisma.browserProfile.create({
      data: { ...rest, status },
    });
  },

  async transition(id: string, projectId: string, to: BrowserProfileStatus) {
    const profile = await prisma.browserProfile.findFirst({
      where: { id, projectId },
    });
    if (!profile)
      throw new AgentelseError(
        "NOT_FOUND",
        `BrowserProfile ${id} not found in project ${projectId}`,
      );

    StateMachine.assertBrowserProfileTransition(profile.status, to);

    return prisma.browserProfile.update({
      where: { id },
      data: { status: to, lastHealthCheckAt: new Date() },
    });
  },
};
