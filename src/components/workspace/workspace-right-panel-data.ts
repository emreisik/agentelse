import "server-only";

import type {
  CreativeStatus,
  CreativeType,
  SocialPlatform,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import { getBrandTwin, type BrandTwin } from "@/server/brand-twin/brand-twin";
import type { LibraryAsset } from "@/components/hub-core/panels/library-browser";

export type WorkspaceOutputItem = {
  id: string;
  type: CreativeType;
  platform: SocialPlatform | null;
  status: CreativeStatus;
  title: string | null;
  createdAt: string;
  assetId: string | null;
};

export type WorkspaceCalendarItem = WorkspaceOutputItem & {
  scheduledFor: string;
};

export type WorkspaceAutopilotMode =
  "REVIEW_EVERYTHING" | "CREATE_AUTOMATICALLY" | "AUTOPILOT";

// Real counts behind the workspace root's "Resume where we left off" card
// (product spec's "Home/Dashboard" section) — deliberately just three status
// buckets, not a full breakdown, so it stays honest without a live feed:
// numbers only, no invented activity text.
export type WorkspaceResumeStats = {
  drafts: number;
  pendingApproval: number;
  approved: number;
};

export type WorkspaceRightPanelData = {
  brand: BrandTwin | null;
  website: string | null;
  autopilotMode: WorkspaceAutopilotMode;
  resumeStats: WorkspaceResumeStats;
  files: LibraryAsset[];
  outputs: WorkspaceOutputItem[];
  calendar: {
    items: WorkspaceCalendarItem[];
    // Approved/in-review/draft creatives with a platform but no
    // scheduledFor yet — listForCalendarRange already returns these
    // alongside the month's scheduled items (its OR clause has no date
    // filter on this branch), so no separate query is needed.
    unscheduled: WorkspaceOutputItem[];
    timezone: string;
    month: string; // "YYYY-MM", the range `items` was fetched for
  };
};

function toOutputItem(
  creative: Awaited<
    ReturnType<typeof CreativeRepository.listRecentForPanel>
  >[number],
): WorkspaceOutputItem {
  return {
    id: creative.id,
    type: creative.type,
    platform: creative.platform,
    status: creative.status,
    title: creative.title,
    createdAt: creative.createdAt.toISOString(),
    assetId: creative.versions[0]?.asset?.id ?? null,
  };
}

// One Promise.all for the Brand Workspace right panel's four tabs (Brand /
// Files / Outputs / Calendar) — same "one fetch, several cheap read models"
// shape as app-shell.tsx's getSidebarData, so the panel doesn't add a
// second request waterfall alongside the page's own root-branch fetch.
// getBrandTwin() runs its own internal composition (see brand-twin.ts) but
// is still just one more parallel branch here, not a second round-trip.
export async function getWorkspaceRightPanelData(
  projectId: string,
  // "YYYY-MM" — the right panel's own inline month navigation (see
  // calendar-panel.tsx's `?calMonth=`), independent of hub-core's
  // panel/sub/entity params. Invalid/absent falls back to the current
  // month, same as before this param existed.
  opts?: { month?: string },
): Promise<WorkspaceRightPanelData> {
  const now = new Date();
  const parsedMonth = opts?.month?.match(/^(\d{4})-(\d{2})$/);
  const year = parsedMonth ? Number(parsedMonth[1]) : now.getFullYear();
  const monthIndex = parsedMonth ? Number(parsedMonth[2]) - 1 : now.getMonth();
  const monthStart = new Date(year, monthIndex, 1);
  const monthEnd = new Date(year, monthIndex + 1, 0, 23, 59, 59);

  const [
    brand,
    project,
    assets,
    recentCreatives,
    calendarCreatives,
    schedule,
    policy,
    statusCounts,
  ] = await Promise.all([
    getBrandTwin(projectId),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { domain: true },
    }),
    prisma.asset.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        size: true,
        createdAt: true,
        type: true,
      },
    }),
    CreativeRepository.listRecentForPanel(projectId),
    CreativeRepository.listForCalendarRange(projectId, {
      from: monthStart,
      to: monthEnd,
    }),
    prisma.projectSchedule.findFirst({
      where: { projectId, capability: "INSTAGRAM_PUBLISH" },
      select: { timezone: true },
    }),
    // Read-only: no upsert here (AutonomyPolicyRepository.getOrCreate would
    // also need workspaceId/brandId this function doesn't otherwise fetch)
    // — a project that hasn't reached its first autonomy-gated action yet
    // simply has no row, and AUTOPILOT (the schema default) is an honest
    // fallback for "not yet configured differently".
    prisma.autonomyPolicy.findUnique({
      where: { projectId },
      select: { autopilotMode: true },
    }),
    prisma.creative.groupBy({
      by: ["status"],
      where: { projectId },
      _count: { _all: true },
    }),
  ]);

  const countFor = (statuses: CreativeStatus[]) =>
    statusCounts
      .filter((row) => statuses.includes(row.status))
      .reduce((sum, row) => sum + row._count._all, 0);

  return {
    brand,
    website: project?.domain ?? null,
    autopilotMode: policy?.autopilotMode ?? "AUTOPILOT",
    resumeStats: {
      drafts: countFor(["DRAFT"]),
      pendingApproval: countFor(["IN_REVIEW"]),
      approved: countFor(["APPROVED", "PUBLISHED"]),
    },
    files: assets.map((asset) => ({
      ...asset,
      createdAt: asset.createdAt.toISOString(),
    })),
    outputs: recentCreatives.map(toOutputItem),
    calendar: {
      items: calendarCreatives
        .filter((creative) => creative.scheduledFor)
        .map((creative) => ({
          ...toOutputItem(creative),
          scheduledFor: creative.scheduledFor!.toISOString(),
        })),
      unscheduled: calendarCreatives
        .filter((creative) => !creative.scheduledFor)
        .map(toOutputItem),
      timezone: schedule?.timezone ?? "Europe/Istanbul",
      month: `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`,
    },
  };
}
