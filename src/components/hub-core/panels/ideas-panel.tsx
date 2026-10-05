import Link from "next/link";
import { ArrowUpRight, Lightbulb, MessageSquarePlus } from "lucide-react";
import type { IdeaStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { timeAgo } from "@/lib/dates";
import { IDEA_STATUS } from "@/lib/labels";
import {
  IDEA_POOL_STATUSES,
  IDEA_PLANNED_STATUSES,
  ideaPlanHref,
} from "@/lib/idea-pool";
import {
  approveIdeaAction,
  archiveIdeaAction,
} from "@/server/actions/agency-strategy-actions";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildHubHref } from "../hub-core-params";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import { EntityDetailSheet } from "../primitives/entity-detail-sheet";
import type { PanelProps } from "./panel-props";

// The idea pool: what the Brand Brain loop and the chat came up with, waiting
// to be planned. A plan made in the chat draws from here first; an idea that
// made it onto the calendar moves to "Planned". The old pipeline's lenses,
// NBA scores and council marks are gone from view (Works ideas have none).

type IdeaRow = {
  id: string;
  title: string;
  description: string;
  status: IdeaStatus;
  createdAt: Date;
  opportunity: { id: string; title: string } | null;
};

const SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  createdAt: true,
  opportunity: { select: { id: true, title: true } },
} as const;

export async function IdeasPanel({ projectId, entity }: PanelProps) {
  const ideaId = entity && entity.kind === "idea" ? entity.id : null;
  return (
    <>
      <IdeaPool projectId={projectId} />
      {ideaId ? (
        <EntityDetailSheet
          title="Idea"
          closeHref={buildHubHref(projectId, { panel: "ideas", entity: null })}
        >
          <IdeaDetail projectId={projectId} ideaId={ideaId} />
        </EntityDetailSheet>
      ) : null}
    </>
  );
}

async function IdeaPool({ projectId }: { projectId: string }) {
  const [pool, planned, archived] = await Promise.all([
    prisma.idea.findMany({
      where: { projectId, status: { in: [...IDEA_POOL_STATUSES] } },
      // Put-forward ideas first, then the newest.
      orderBy: [{ createdAt: "desc" }],
      take: 100,
      select: SELECT,
    }),
    prisma.idea.findMany({
      where: { projectId, status: { in: [...IDEA_PLANNED_STATUSES] } },
      orderBy: { updatedAt: "desc" },
      take: 30,
      select: SELECT,
    }),
    prisma.idea.findMany({
      where: { projectId, status: { in: ["ARCHIVED", "REJECTED", "LEARNED"] } },
      orderBy: { updatedAt: "desc" },
      take: 30,
      select: SELECT,
    }),
  ]);
  const ordered = [
    ...pool.filter((idea) => idea.status === "APPROVED"),
    ...pool.filter((idea) => idea.status !== "APPROVED"),
  ];

  if (ordered.length + planned.length + archived.length === 0) {
    return (
      <div className="py-6">
        <EmptyState
          icon={Lightbulb}
          title="No ideas yet"
          hint="The Brand Brain turns what it learns about your market into ideas every day, and ideas you save in the chat land here too. Plans made in the chat draw from this pool first."
        />
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-10">
      <p className="text-sm text-muted-foreground">
        Plans made in the chat draw from this pool first. Put an idea forward to
        have it picked before the others.
      </p>
      <IdeaGroup
        title="In the pool"
        projectId={projectId}
        ideas={ordered}
        empty="The pool is empty: new ideas arrive as the Brand Brain learns."
        actions
      />
      {planned.length > 0 ? (
        <IdeaGroup title="Planned" projectId={projectId} ideas={planned} />
      ) : null}
      {archived.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer text-sm font-semibold text-muted-foreground">
            Archive ({archived.length})
          </summary>
          <div className="mt-3">
            <IdeaGroup projectId={projectId} ideas={archived} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function IdeaGroup({
  title,
  projectId,
  ideas,
  empty,
  actions = false,
}: {
  title?: string;
  projectId: string;
  ideas: IdeaRow[];
  empty?: string;
  actions?: boolean;
}) {
  return (
    <section className="space-y-2">
      {title ? (
        <h2 className="text-sm font-semibold text-foreground">
          {title}{" "}
          <span className="font-normal text-muted-foreground">
            ({ideas.length})
          </span>
        </h2>
      ) : null}
      {ideas.length === 0 && empty ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl ring-1 ring-foreground/10">
          {ideas.map((idea) => (
            <li
              key={idea.id}
              data-idea={idea.id}
              className="flex items-start gap-3 px-4 py-3"
            >
              <Link
                href={buildHubHref(projectId, {
                  panel: "ideas",
                  entity: { kind: "idea", id: idea.id },
                })}
                scroll={false}
                className="min-w-0 flex-1"
              >
                <span className="block truncate text-sm font-medium text-foreground">
                  {idea.title}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                  {idea.description}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <StatusBadge
                    meta={IDEA_STATUS[idea.status]}
                    className="h-4 px-1.5 text-[10px]"
                  />
                  <span>
                    {idea.opportunity
                      ? "From the Brand Brain"
                      : "From the chat"}
                  </span>
                  <span>{timeAgo(idea.createdAt)}</span>
                </span>
              </Link>
              {actions ? (
                <Link
                  href={ideaPlanHref(projectId, idea.id)}
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "shrink-0",
                  )}
                >
                  <MessageSquarePlus className="size-3.5" />
                  Plan in chat
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

async function IdeaDetail({
  projectId,
  ideaId,
}: {
  projectId: string;
  ideaId: string;
}) {
  const idea = await prisma.idea.findFirst({
    where: { id: ideaId, projectId },
    select: { ...SELECT, updatedAt: true },
  });

  if (!idea) {
    return (
      <div className="space-y-4 py-6">
        <EmptyState icon={Lightbulb} title="Idea not found" />
      </div>
    );
  }

  const inPool = (IDEA_POOL_STATUSES as readonly IdeaStatus[]).includes(
    idea.status,
  );
  const canArchive = idea.status !== "ARCHIVED" && idea.status !== "REJECTED";

  return (
    <div className="space-y-6 py-6">
      <div>
        <h2 className="font-heading text-xl font-semibold text-foreground">
          {idea.title}
        </h2>
        <p className="mt-2 text-sm whitespace-pre-line text-muted-foreground">
          {idea.description}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge meta={IDEA_STATUS[idea.status]} />
        <span>Added {timeAgo(idea.createdAt)}</span>
      </div>

      {idea.opportunity ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "opportunity", id: idea.opportunity.id }}
          text={`From the opportunity: ${idea.opportunity.title}`}
        />
      ) : null}

      <div className="flex flex-wrap gap-2">
        {inPool ? (
          <Link
            href={ideaPlanHref(projectId, idea.id)}
            className={buttonVariants({ size: "sm" })}
          >
            <ArrowUpRight className="size-3.5" />
            Plan in chat
          </Link>
        ) : null}
        {inPool && idea.status !== "APPROVED" ? (
          <ActionForm
            action={approveIdeaAction}
            successMessage="Put forward: plans pick it first"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="ideaId" value={idea.id} />
            <SubmitButton size="sm" variant="outline">
              Put forward
            </SubmitButton>
          </ActionForm>
        ) : null}
        {canArchive ? (
          <ActionForm action={archiveIdeaAction} successMessage="Idea archived">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="ideaId" value={idea.id} />
            <SubmitButton size="sm" variant="ghost">
              Archive
            </SubmitButton>
          </ActionForm>
        ) : null}
      </div>
    </div>
  );
}
