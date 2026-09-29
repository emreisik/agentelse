import "server-only";

import type { SetupStage } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { SetupIntake } from "./project-setup-orchestrator";

type Scope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type DemoPostPlatform = "INSTAGRAM" | "TIKTOK" | "LINKEDIN";

export type DemoPostItem = {
  id: string;
  stage: SetupStage;
  headline: string;
  caption: string;
  platform: DemoPostPlatform;
  accentIndex: number;
  createdAt: string;
};

// Which stages get a demo post — exactly the ones that produce something
// concrete enough to preview (mirrors setup-progress-view.tsx's findingFor,
// kept independent rather than imported from it: that file is a React
// component module, this one is plain server logic the orchestrator calls).
export const DEMO_POST_STAGES: readonly SetupStage[] = [
  "DEEP_DISCOVERY",
  "BRAND_CONSTITUTION",
  "SIGNAL_PROFILE",
  "BASELINE_AUDITS",
  "GOAL_GENERATION",
  "INITIAL_OPPORTUNITIES",
  "INITIAL_IDEA_PORTFOLIO",
  "INITIAL_WORK_PLAN",
];

const PLATFORMS: readonly DemoPostPlatform[] = [
  "INSTAGRAM",
  "TIKTOK",
  "LINKEDIN",
];

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// Deliberately template-based, no reasoning-service call: this runs on every
// completed setup stage and has to be instant and free — a "here's a demo
// post" preview, not a real deliverable (see command-service.ts's real
// CREATE_SOCIAL_CREATIVE path for that). brandName always comes from the
// intake the client already gave (agency-setup-actions.ts), never invented.
export async function generateDemoPost(
  scope: Scope,
  stage: SetupStage,
  intake: SetupIntake,
): Promise<DemoPostItem | null> {
  const brandName = intake.brandName;
  const stageIndex = DEMO_POST_STAGES.indexOf(stage);
  if (stageIndex === -1) return null;

  const content = await stageContent(scope, stage, brandName);
  if (!content) return null;

  return {
    id: stage,
    stage,
    headline: content.headline,
    caption: content.caption,
    platform: PLATFORMS[stageIndex % PLATFORMS.length]!,
    accentIndex: stageIndex % 4,
    createdAt: new Date().toISOString(),
  };
}

async function stageContent(
  scope: Scope,
  stage: SetupStage,
  brandName: string,
): Promise<{ headline: string; caption: string } | null> {
  const { projectId } = scope;

  switch (stage) {
    case "DEEP_DISCOVERY": {
      const [count, latest] = await Promise.all([
        prisma.signal.count({ where: { projectId } }),
        prisma.signal.findFirst({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          select: { title: true },
        }),
      ]);
      if (count === 0) return null;
      return {
        headline: latest
          ? truncate(latest.title, 60)
          : `${count} signals found`,
        caption: `New research on ${brandName} is already coming in.`,
      };
    }

    case "BRAND_CONSTITUTION": {
      const constitution = await prisma.brandConstitution.findFirst({
        where: { projectId },
        orderBy: { version: "desc" },
        select: { summary: true },
      });
      if (!constitution) return null;
      return {
        headline: constitution.summary
          ? truncate(constitution.summary, 60)
          : `${brandName}'s story, defined`,
        caption: "Meet the brand voice we'll be creating with.",
      };
    }

    case "SIGNAL_PROFILE": {
      const count = await prisma.projectSignalProfile.count({
        where: { projectId },
      });
      if (count === 0) return null;
      return {
        headline: "Tuned in",
        caption: `${brandName} now has a live signal profile watching ${count} categor${count === 1 ? "y" : "ies"}.`,
      };
    }

    case "BASELINE_AUDITS": {
      const count = await prisma.baselineAudit.count({ where: { projectId } });
      if (count === 0) return null;
      return {
        headline: `Where ${brandName} stands today`,
        caption: `${count} department audit${count === 1 ? "" : "s"} complete — a real baseline to grow from.`,
      };
    }

    case "GOAL_GENERATION": {
      const [count, latest] = await Promise.all([
        prisma.projectGoal.count({ where: { projectId } }),
        prisma.projectGoal.findFirst({
          where: { projectId },
          orderBy: { priority: "asc" },
          select: { title: true },
        }),
      ]);
      if (count === 0) return null;
      return {
        headline: latest
          ? truncate(latest.title, 60)
          : `${count} goals proposed`,
        caption: `Here's one of the goals we think ${brandName} should chase first.`,
      };
    }

    case "INITIAL_OPPORTUNITIES": {
      const [count, latest] = await Promise.all([
        prisma.opportunity.count({ where: { projectId } }),
        prisma.opportunity.findFirst({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          select: { title: true },
        }),
      ]);
      if (count === 0) return null;
      return {
        headline: latest
          ? truncate(latest.title, 60)
          : `${count} opportunities spotted`,
        caption: `${brandName} has real openings waiting to be turned into content.`,
      };
    }

    case "INITIAL_IDEA_PORTFOLIO": {
      const [count, latest] = await Promise.all([
        prisma.idea.count({ where: { projectId } }),
        prisma.idea.findFirst({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          select: { title: true },
        }),
      ]);
      if (count === 0) return null;
      return {
        headline: latest ? truncate(latest.title, 60) : `${count} ideas ready`,
        caption: `A first taste of what we'll be creating for ${brandName}.`,
      };
    }

    case "INITIAL_WORK_PLAN": {
      const [count, latest] = await Promise.all([
        prisma.workPlan.count({ where: { projectId } }),
        prisma.workPlan.findFirst({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          select: { title: true },
        }),
      ]);
      if (count === 0) return null;
      return {
        headline: latest
          ? truncate(latest.title, 60)
          : "The plan is taking shape",
        caption: `${brandName}'s first work plan is coming together.`,
      };
    }

    default:
      return null;
  }
}
