import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import { shortDate } from "@/lib/dates";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { CreativeImageStudio } from "@/components/creative/creative-image-studio";
import { StatusBadge } from "@/components/shared/status-badge";
import { ImageLightbox } from "@/components/shared/image-lightbox";
import { CREATIVE_STATUS } from "@/lib/labels";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";

export default async function CreativeDetailPage({
  params,
}: PageProps<"/creatives/[creativeId]">) {
  const { creativeId } = await params;
  const { userId } = await requireUser();

  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    include: {
      versions: { orderBy: { version: "desc" }, include: { asset: true } },
    },
  });
  if (!creative) notFound();

  try {
    await requireProjectAccess(userId, creative.projectId);
  } catch (error) {
    if (
      isAgentelseError(error) &&
      (error.code === "NOT_FOUND" || error.code === "PERMISSION_DENIED")
    ) {
      notFound();
    }
    throw error;
  }

  const [project, pendingApproval] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: creative.projectId } }),
    prisma.approval.findFirst({
      where: {
        entityType: "Creative",
        entityId: creative.id,
        status: "PENDING",
      },
    }),
  ]);

  return (
    <AppShell projectId={project.id}>
      <div className="p-6 space-y-6 max-w-3xl">
        <div>
          <Link
            href={`/projects/${project.id}`}
            className="text-sm text-muted-foreground hover:underline"
          >
            ← {project.name}
          </Link>
          <div className="flex items-center justify-between mt-1">
            <h1 className="text-xl font-semibold tracking-tight">
              {creative.title ?? creative.type}
            </h1>
            <StatusBadge
              meta={CREATIVE_STATUS[creative.status]}
              fallback={creative.status}
            />
          </div>
          {creative.platform ? (
            <p className="text-sm text-muted-foreground">{creative.platform}</p>
          ) : null}
        </div>

        {pendingApproval ? (
          <Card>
            <CardContent className="flex items-center justify-between pt-6">
              <p className="text-sm text-muted-foreground">
                This creative is awaiting approval.
              </p>
              <div className="flex gap-2">
                <ActionForm
                  action={rejectApprovalAction}
                  successMessage="Approval rejected"
                >
                  <input
                    type="hidden"
                    name="approvalId"
                    value={pendingApproval.id}
                  />
                  <SubmitButton variant="outline" size="sm">
                    Reject
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={approveApprovalAction}
                  successMessage="Approved"
                >
                  <input
                    type="hidden"
                    name="approvalId"
                    value={pendingApproval.id}
                  />
                  <SubmitButton size="sm">Approve</SubmitButton>
                </ActionForm>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <div className="space-y-4">
          {creative.versions.map((version, index) => {
            const versionFormat = getCreativePlatformFormat(
              creative.platform,
              version.contentFormat,
            );
            return (
              <Card key={version.id}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-base">
                    v{version.version}
                    {index === 0 ? (
                      <Badge className="ml-2" variant="secondary">
                        current
                      </Badge>
                    ) : null}
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">
                    {shortDate(version.createdAt)}
                  </span>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {version.generationProvider ? (
                    <p className="text-xs text-muted-foreground">
                      Generated by: <code>{version.generationProvider}</code>
                      {version.generationProvider
                        .toLowerCase()
                        .includes("mock") ? (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          DEMO / MOCK
                        </Badge>
                      ) : null}
                    </p>
                  ) : null}

                  {version.asset ? (
                    version.asset.storageKey.startsWith("mock://") ? (
                      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                        Asset: <code>{version.asset.storageKey}</code>
                        <span className="ml-2">
                          (placeholder — no real image generated)
                        </span>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <ImageLightbox
                          src={`/api/assets/${version.asset.id}`}
                          alt={version.asset.filename}
                          title={`v${version.version}`}
                          className="block"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/assets/${version.asset.id}`}
                            alt=""
                            className="max-w-full rounded-md border"
                          />
                        </ImageLightbox>
                        {version.asset.width && version.asset.height ? (
                          <p className="text-[11px] text-muted-foreground">
                            {version.asset.width} × {version.asset.height} px
                            {creative.platform
                              ? ` · ${versionFormat.label} · ${versionFormat.contentFormatLabel}`
                              : ""}
                          </p>
                        ) : null}
                        <a
                          href={`/api/assets/${version.asset.id}`}
                          download={version.asset.filename}
                          className="text-xs text-primary underline-offset-2 hover:underline"
                        >
                          Download image
                        </a>
                      </div>
                    )
                  ) : null}

                  {index === 0 ? (
                    <CreativeImageStudio
                      creativeId={creative.id}
                      platform={creative.platform}
                      hasImage={Boolean(
                        version.asset &&
                        !version.asset.storageKey.startsWith("mock://"),
                      )}
                    />
                  ) : null}

                  {version.caption ? (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">
                        Caption
                      </p>
                      <p className="whitespace-pre-wrap">{version.caption}</p>
                    </div>
                  ) : null}

                  {version.copy ? (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">
                        Copy
                      </p>
                      <p className="whitespace-pre-wrap">{version.copy}</p>
                    </div>
                  ) : null}

                  {version.revisionReason ? (
                    <>
                      <Separator />
                      <p className="text-xs text-muted-foreground">
                        Revision reason: {version.revisionReason}
                      </p>
                    </>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}

          {creative.versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No versions yet.</p>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
