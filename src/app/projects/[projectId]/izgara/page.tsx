import Link from "next/link";
import { notFound } from "next/navigation";
import { ImageOff, Sparkles } from "lucide-react";

import { prisma } from "@/lib/prisma";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { scheduleGridSeriesAction } from "@/server/actions/creative-grid-actions";
import { SOCIAL_PLATFORM } from "@/lib/labels";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { ImageLightbox } from "@/components/shared/image-lightbox";
import { SubmitButton } from "@/components/shared/submit-button";
import { GridSplitStudio } from "@/components/creative/grid-split-studio";
import { Card, CardContent } from "@/components/ui/card";
import type { Prisma } from "@prisma/client";

type GridCreative = Prisma.CreativeGetPayload<{
  include: { versions: { include: { asset: true } } };
}>;

// Instagram Grid Studio (spec: izgara) — a 3-column preview of how the
// project's Instagram content will read on the real profile grid (newest
// first, left-to-right/top-to-bottom — the ONLY thing that determines
// grid order is publish time, see Creative.scheduledFor's schema
// comment), a "split one image into a grid-puzzle series" tool
// (creative-grid-split.ts), and AI-sourced suggestions pulled from the
// project's existing Ideas/unscheduled approved creatives. Same
// RSC-first, searchParam-driven architecture as takvim/page.tsx — no
// client calendar/grid state, only the split panel's own pre-submit
// toggles are client-side (grid-split-studio.tsx).
function assetUrl(id: string): string {
  return `/api/assets/${id}`;
}
function hasRealImage(creative: GridCreative): boolean {
  const asset = creative.versions[0]?.asset;
  return Boolean(asset && !asset.storageKey.startsWith("mock://"));
}

export default async function InstagramGridPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const { userId } = await requireUser();

  try {
    await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (
      isAgentelseError(error) &&
      (error.code === "NOT_FOUND" || error.code === "PERMISSION_DENIED")
    ) {
      notFound();
    }
    throw error;
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  if (!project) notFound();

  const versionInclude = {
    versions: {
      orderBy: { version: "desc" as const },
      take: 1,
      include: { asset: true },
    },
  };

  const [
    gridPreview,
    pendingGridFlat,
    suggestionCreatives,
    suggestionIdeas,
    recentSourceRows,
  ] = await Promise.all([
    prisma.creative.findMany({
      where: {
        projectId,
        platform: "INSTAGRAM",
        status: { in: ["APPROVED", "PUBLISHED"] },
      },
      include: versionInclude,
      orderBy: [
        { scheduledFor: { sort: "desc", nulls: "last" } },
        { updatedAt: "desc" },
      ],
      take: 24,
    }) as Promise<GridCreative[]>,
    prisma.creative.findMany({
      where: { projectId, gridGroupId: { not: null }, scheduledFor: null },
      include: versionInclude,
      orderBy: [{ gridGroupId: "asc" }, { gridPosition: "asc" }],
    }) as Promise<GridCreative[]>,
    prisma.creative.findMany({
      where: {
        projectId,
        platform: "INSTAGRAM",
        status: "APPROVED",
        scheduledFor: null,
        gridGroupId: null,
      },
      include: versionInclude,
      orderBy: { createdAt: "desc" },
      take: 12,
    }) as Promise<GridCreative[]>,
    prisma.idea.findMany({
      where: {
        projectId,
        status: { in: ["SHORTLISTED", "APPROVED", "PLANNING"] },
      },
      select: { id: true, title: true, description: true },
      orderBy: { updatedAt: "desc" },
      take: 8,
    }),
    prisma.creative.findMany({
      where: { projectId },
      include: versionInclude,
      orderBy: { createdAt: "desc" },
      take: 16,
    }) as Promise<GridCreative[]>,
  ]);

  const pendingGroups = new Map<string, GridCreative[]>();
  for (const creative of pendingGridFlat) {
    if (!creative.gridGroupId) continue;
    const bucket = pendingGroups.get(creative.gridGroupId);
    if (bucket) bucket.push(creative);
    else pendingGroups.set(creative.gridGroupId, [creative]);
  }

  const recentSources = recentSourceRows
    .filter(hasRealImage)
    .slice(0, 10)
    .map((creative) => ({
      assetId: creative.versions[0]!.asset!.id,
      label: creative.title ?? "Untitled",
    }));

  const promptSeed =
    typeof sp.promptSeed === "string" ? sp.promptSeed : undefined;
  const base = `/projects/${projectId}/izgara`;

  return (
    <AppShell projectId={projectId}>
      <div className="space-y-6 p-6 pb-16">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Instagram Grid Studio
          </h1>
          <p className="text-sm text-muted-foreground">
            {project.name} — preview the profile grid, split one image into a
            posted series, fill gaps from your ideas
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-6">
            <section>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">
                Grid preview (newest first, like a real profile)
              </h2>
              {gridPreview.length === 0 ? (
                <Card size="sm">
                  <CardContent className="py-8 text-center text-sm text-muted-foreground">
                    No approved or published Instagram posts yet.
                  </CardContent>
                </Card>
              ) : (
                <div className="grid grid-cols-3 gap-0.5 overflow-hidden rounded-lg border border-border">
                  {gridPreview.map((creative) => (
                    <GridTile
                      key={creative.id}
                      creative={creative}
                      projectId={projectId}
                    />
                  ))}
                </div>
              )}
            </section>

            {pendingGroups.size > 0 ? (
              <section className="space-y-3">
                <h2 className="text-sm font-medium text-muted-foreground">
                  Pending grid splits — schedule to publish
                </h2>
                {[...pendingGroups.entries()].map(([groupId, tiles]) => (
                  <PendingGroupCard
                    key={groupId}
                    groupId={groupId}
                    tiles={tiles}
                    projectId={projectId}
                  />
                ))}
              </section>
            ) : null}
          </div>

          <div className="space-y-6">
            <GridSplitStudio
              projectId={projectId}
              recentSources={recentSources}
              initialPrompt={promptSeed}
            />

            <section className="space-y-2">
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                <Sparkles className="size-3.5" />
                Ready to slot in
              </h2>
              {suggestionCreatives.length === 0 &&
              suggestionIdeas.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing waiting right now.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {suggestionCreatives.map((creative) => (
                    <Link
                      key={creative.id}
                      href={`/projects/${projectId}/takvim?creative=${creative.id}`}
                      className="flex items-center gap-2 rounded-lg p-1.5 ring-1 ring-foreground/10 transition-colors hover:bg-accent"
                    >
                      {hasRealImage(creative) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={assetUrl(creative.versions[0]!.asset!.id)}
                          alt=""
                          className="size-9 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                          <ImageOff className="size-3.5" />
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {creative.title ?? "Untitled"}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        approved, unscheduled
                      </span>
                    </Link>
                  ))}
                  {suggestionIdeas.map((idea) => (
                    <Link
                      key={idea.id}
                      href={`${base}?promptSeed=${encodeURIComponent(`${idea.title}: ${idea.description}`)}`}
                      className="block rounded-lg p-2 ring-1 ring-foreground/10 transition-colors hover:bg-accent"
                    >
                      <p className="truncate text-xs font-medium">
                        {idea.title}
                      </p>
                      <p className="truncate text-[10px] text-muted-foreground">
                        idea — click to use as a prompt
                      </p>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function GridTile({
  creative,
  projectId,
}: {
  creative: GridCreative;
  projectId: string;
}) {
  const asset = creative.versions[0]?.asset;
  if (!hasRealImage(creative) || !asset) {
    return (
      <div className="flex aspect-square items-center justify-center bg-muted text-muted-foreground">
        <ImageOff className="size-4" />
      </div>
    );
  }
  return (
    <Link
      href={`/projects/${projectId}/takvim?creative=${creative.id}`}
      className="group relative block aspect-square overflow-hidden"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={assetUrl(asset.id)}
        alt=""
        className="size-full object-cover transition-transform group-hover:scale-105"
      />
      {creative.status === "APPROVED" ? (
        <span className="absolute right-1 top-1 rounded bg-background/90 px-1 py-0.5 text-[9px] font-medium">
          scheduled
        </span>
      ) : null}
    </Link>
  );
}

function PendingGroupCard({
  groupId,
  tiles,
  projectId,
}: {
  groupId: string;
  tiles: GridCreative[];
  projectId: string;
}) {
  return (
    <Card size="sm">
      <CardContent className="space-y-3 p-3">
        <div className="flex items-center gap-2">
          {tiles.map((tile) => {
            const asset = tile.versions[0]?.asset;
            return (
              <ImageLightbox
                key={tile.id}
                src={asset ? assetUrl(asset.id) : ""}
                alt={`Part ${tile.gridPosition}/${tiles.length}`}
                title={tile.title ?? undefined}
              >
                {asset ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={assetUrl(asset.id)}
                    alt=""
                    className="size-14 rounded object-cover ring-1 ring-foreground/10"
                  />
                ) : (
                  <span className="flex size-14 items-center justify-center rounded bg-muted text-muted-foreground">
                    <ImageOff className="size-4" />
                  </span>
                )}
              </ImageLightbox>
            );
          })}
          <span className="text-xs text-muted-foreground">
            {tiles.length} parts — {SOCIAL_PLATFORM.INSTAGRAM.label}
          </span>
        </div>

        <ActionForm
          action={scheduleGridSeriesAction}
          successMessage="Series scheduled"
          className="flex flex-wrap items-end gap-2"
        >
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="gridGroupId" value={groupId} />
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">
              First post goes out at
            </span>
            <input
              type="datetime-local"
              name="start"
              required
              className="h-8 rounded-md border border-input bg-transparent px-2.5 text-xs"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">
              Minutes between posts
            </span>
            <input
              type="number"
              name="intervalMinutes"
              defaultValue={60}
              min={1}
              className="h-8 w-24 rounded-md border border-input bg-transparent px-2.5 text-xs"
            />
          </label>
          <SubmitButton size="sm" variant="outline">
            Schedule series
          </SubmitButton>
        </ActionForm>
        <p className="text-[10px] text-muted-foreground">
          Posts go out in reverse order automatically so the grid reads
          correctly once they&rsquo;re all live.
        </p>
      </CardContent>
    </Card>
  );
}
