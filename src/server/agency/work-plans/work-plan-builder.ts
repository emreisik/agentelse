import "server-only";

import type { CapabilityKey, DepartmentKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { taskFingerprint } from "@/server/agency/fingerprint";
import { TaskPlanner } from "@/server/commands/task-planner";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { WorkPlanRepository } from "@/server/repositories/work-plan.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";

// Turns an approved multi-department idea into a WorkPlan with a task
// dependency graph (spec section 26). Deterministic template: strategy leads,
// creative/copy fan out, channel planning joins them, externally visible
// steps park behind approval, analytics closes the loop.

export type PlanNode = {
  key: string;
  capability: CapabilityKey;
  department: DepartmentKey;
  dependsOnKeys: string[];
  request: string;
};

// Per-department campaign contribution (spec section 26's example tree).
const DEPARTMENT_CONTRIBUTIONS: Partial<
  Record<DepartmentKey, { capability: CapabilityKey; label: string }>
> = {
  BRAND_STRATEGY: {
    capability: "CREATE_CAMPAIGN_BRIEF",
    label: "positioning + campaign brief",
  },
  CREATIVE: {
    capability: "CREATE_SOCIAL_CREATIVE",
    label: "big idea / visual system",
  },
  ART_DIRECTION: { capability: "CREATE_AD_CREATIVE", label: "art direction" },
  COPY_CONTENT: { capability: "CREATE_COPY", label: "messaging" },
  SOCIAL_MEDIA: { capability: "CREATE_CONTENT_PLAN", label: "content plan" },
  SEO: { capability: "SEO_ANALYSIS", label: "search opportunity" },
  WEB_PRODUCT: { capability: "WEBSITE_UPDATE", label: "landing page" },
  PERFORMANCE_MARKETING: {
    capability: "META_ADS_ANALYSIS",
    label: "media plan",
  },
  PR_MEDIA: { capability: "PR_OUTREACH", label: "story angle + outreach" },
  INFLUENCER_CREATOR: {
    capability: "CREATOR_RESEARCH",
    label: "creator shortlist",
  },
  DATA_ANALYTICS: { capability: "REPORTING", label: "measurement plan" },
  GROWTH: {
    capability: "ANALYTICS_ANALYSIS",
    label: "growth experiment design",
  },
  PARTNERSHIPS: {
    capability: "PARTNERSHIP_RESEARCH",
    label: "partner shortlist",
  },
  CRM_LIFECYCLE: { capability: "EMAIL_DRAFT", label: "lifecycle messaging" },
};

export function buildCampaignNodes(
  title: string,
  departments: DepartmentKey[],
): PlanNode[] {
  const wanted = new Set(departments);
  // Strategy always leads; analytics always closes.
  wanted.add("BRAND_STRATEGY");
  wanted.add("DATA_ANALYTICS");

  const nodes: PlanNode[] = [];
  const strategyKey = "strategy";
  nodes.push({
    key: strategyKey,
    capability: "CREATE_CAMPAIGN_BRIEF",
    department: "BRAND_STRATEGY",
    dependsOnKeys: [],
    request: `${title} — positioning + campaign brief`,
  });

  const middleKeys: string[] = [];
  for (const department of wanted) {
    if (department === "BRAND_STRATEGY" || department === "DATA_ANALYTICS")
      continue;
    const contribution = DEPARTMENT_CONTRIBUTIONS[department];
    if (!contribution) continue;
    const key = department.toLowerCase();
    nodes.push({
      key,
      capability: contribution.capability,
      department,
      dependsOnKeys: [strategyKey],
      request: `${title} — ${contribution.label}`,
    });
    middleKeys.push(key);
  }

  nodes.push({
    key: "measurement",
    capability: "REPORTING",
    department: "DATA_ANALYTICS",
    dependsOnKeys: middleKeys.length > 0 ? middleKeys : [strategyKey],
    request: `${title} — measurement plan`,
  });

  return nodes;
}

export const WorkPlanBuilder = {
  // Creates the plan + all node tasks (deferred dispatch), wires
  // TaskDependency rows, then dispatches the root nodes.
  async buildForIdea(input: {
    ideaId: string;
    projectId: string;
    decisionId: string;
    departments: string[];
  }): Promise<{ workPlanId: string; taskIds: string[] }> {
    const idea = await IdeaRepository.findByIdInProject(
      input.ideaId,
      input.projectId,
    );
    if (!idea) throw new Error(`Idea ${input.ideaId} not found`);

    const scope = {
      workspaceId: idea.workspaceId,
      projectId: idea.projectId,
      brandId: idea.brandId,
    };

    const opportunityGoalIds = idea.opportunityId
      ? await prisma.opportunity
          .findUnique({
            where: { id: idea.opportunityId },
            select: { goalIds: true },
          })
          .then((o) => o?.goalIds ?? [])
      : [];

    const departments = input.departments.filter(
      (d): d is DepartmentKey =>
        d in DEPARTMENT_CONTRIBUTIONS ||
        d === "BRAND_STRATEGY" ||
        d === "DATA_ANALYTICS",
    );
    const nodes = buildCampaignNodes(idea.title, departments);

    const plan = await WorkPlanRepository.create({
      ...scope,
      ideaId: idea.id,
      opportunityId: idea.opportunityId ?? undefined,
      decisionId: input.decisionId,
      title: idea.title,
      planType: departments.length > 1 ? "MULTI_DEPARTMENT" : "CAMPAIGN",
      goalIds: opportunityGoalIds,
      graph: nodes,
      isMock: idea.isMock,
    });

    // Create every node task (deferred), record key->taskId, wire deps.
    const taskIdByKey = new Map<string, string>();
    for (const node of nodes) {
      const planned = await TaskPlanner.planForCapability({
        ...scope,
        capability: node.capability,
        request: node.request,
        createdByType: "SYSTEM",
        departmentKey: node.department,
        workPlanId: plan.id,
        goalIds: opportunityGoalIds,
        fingerprint: taskFingerprint({
          capability: node.capability,
          department: node.department,
          subject: `${plan.id}:${node.key}`,
        }),
        sourceDecisionId: input.decisionId,
        deferDispatch: true,
      });
      taskIdByKey.set(node.key, planned.task.id);
    }

    for (const node of nodes) {
      const taskId = taskIdByKey.get(node.key);
      if (!taskId) continue;
      for (const depKey of node.dependsOnKeys) {
        const dependsOnTaskId = taskIdByKey.get(depKey);
        if (dependsOnTaskId) {
          await TaskRepository.addDependency(taskId, dependsOnTaskId);
        }
      }
    }

    await WorkPlanRepository.transition(plan.id, input.projectId, "APPROVED");
    await WorkPlanRepository.transition(
      plan.id,
      input.projectId,
      "IN_PROGRESS",
    );

    // Progress root nodes (no dependencies) — dispatched immediately, or
    // parked for approval if the capability requires it.
    const { WorkPlanProgressor } = await import("./work-plan-progressor");
    await WorkPlanProgressor.dispatchReadyTasks(plan.id, input.projectId);

    await IdeaChatRepository.postSystemMessage({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ideaId: idea.id,
      text: `📋 Converted to work plan: **${plan.title}**`,
      card: {
        kind: "work-plan",
        title: plan.title,
        nodes: nodes.map((node) => ({
          department: node.department,
          request: node.request,
        })),
      },
    }).catch((error) => {
      console.error("[work-plan-builder] postSystemMessage failed:", error);
    });

    return {
      workPlanId: plan.id,
      taskIds: [...taskIdByKey.values()],
    };
  },
};
