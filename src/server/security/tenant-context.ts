import "server-only";

import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";

export type AuthenticatedUser = {
  userId: string;
  email: string | null;
};

// Resolves the current session user. Every server action / route handler that
// touches tenant-scoped data must call this first — there is no other place
// authorization is checked.
export async function requireUser(): Promise<AuthenticatedUser> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new AgentelseError("LOGIN_REQUIRED", "Authentication required");
  }
  return { userId: session.user.id, email: session.user.email ?? null };
}

// Page-level guard for route segments (layouts), as opposed to server
// actions/route handlers: a stale or missing session must land the visitor
// back on /login, never throw into an unhandled server error. Use this in
// layout.tsx files that sit above authenticated pages; keep using
// requireUser() inside server actions and route handlers, where throwing is
// the correct behavior.
export async function requireUserOrRedirect(): Promise<AuthenticatedUser> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }
  return { userId: session.user.id, email: session.user.email ?? null };
}

// Confirms the user belongs to the workspace that owns `projectId`, and
// returns the resolved workspaceId/brandId so callers never have to trust an
// unauthenticated brandId passed in from the client. This is the single
// choke point that prevents cross-project IDOR (biduniq task resolving a
// bitypay browser profile, etc.) — every repository call for tenant data
// must flow through the { workspaceId, projectId } it returns here rather
// than IDs supplied directly by the caller.
export async function requireProjectAccess(
  userId: string,
  projectId: string,
): Promise<{ workspaceId: string; projectId: string; defaultBrandId: string }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      workspaceId: true,
      brands: { where: { isDefault: true }, select: { id: true }, take: 1 },
    },
  });

  if (!project) {
    throw new AgentelseError("NOT_FOUND", `Project ${projectId} not found`);
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
    select: { id: true },
  });

  if (!membership) {
    throw new AgentelseError(
      "PERMISSION_DENIED",
      `User ${userId} has no access to workspace ${project.workspaceId}`,
    );
  }

  const defaultBrandId = project.brands[0]?.id;
  if (!defaultBrandId) {
    throw new AgentelseError(
      "NOT_FOUND",
      `Project ${projectId} has no default brand`,
    );
  }

  return {
    workspaceId: project.workspaceId,
    projectId: project.id,
    defaultBrandId,
  };
}

// Confirms `brandId` actually belongs to `projectId`. Every mutation that
// receives both a projectId and a brandId from a client payload must call
// this — otherwise a Biduniq task could be pointed at a BityPay brand by
// passing an arbitrary brandId in the request body.
export async function requireBrandInProject(
  brandId: string,
  projectId: string,
): Promise<void> {
  const brand = await prisma.brand.findUnique({
    where: { id: brandId },
    select: { projectId: true },
  });

  if (!brand || brand.projectId !== projectId) {
    throw new AgentelseError(
      "PROJECT_MISMATCH",
      `Brand ${brandId} does not belong to project ${projectId}`,
    );
  }
}

// Confirms a BrowserProfile belongs to the given project. Used by the
// execution router before dispatching to OpenClaw — a BityPay task must
// never be able to run against a biduniq-instagram profile.
export async function requireBrowserProfileInProject(
  browserProfileId: string,
  projectId: string,
): Promise<void> {
  const profile = await prisma.browserProfile.findUnique({
    where: { id: browserProfileId },
    select: { projectId: true },
  });

  if (!profile || profile.projectId !== projectId) {
    throw new AgentelseError(
      "BROWSER_PROFILE_MISMATCH",
      `Browser profile ${browserProfileId} does not belong to project ${projectId}`,
    );
  }
}

// Resolves the caller's workspace membership for workspace-level pages.
// A stale session (JWT pointing at a deleted user, e.g. after a re-seed)
// must land back on /login, never 500 the page — hence redirect, not throw.
export async function requireWorkspaceMembership(
  userId: string,
): Promise<{ workspaceId: string }> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId },
    select: { workspaceId: true },
  });
  if (!membership) redirect("/login");
  return { workspaceId: membership.workspaceId };
}
