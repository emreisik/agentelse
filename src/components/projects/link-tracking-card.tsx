import { Link2 } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { utmFeatureOn } from "@/lib/tracked-links/flags";
import { LINK_TRACKING_COPY, bioDefaultUrl } from "@/lib/tracked-links/copy";
import {
  saveInstagramBioLinkAction,
  updateLinkTrackingAction,
} from "@/server/actions/link-tracking-actions";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { loadInstagramBioLink } from "@/server/tracked-links/bio";
import { loadLinkTrackingSettings } from "@/server/tracked-links/settings";
import { CopyButton } from "@/components/calendar/copy-button";
import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

// Ayarlar > Publishing: "Link tracking" (GA_UTM). Kapalıyken hiçbir sorgu yok.
// requireUser / requireProjectAccess sayfada zaten çözülmüş (cache) olduğundan
// ek bir kiracı sorgusu eklemez.
export async function LinkTrackingCard({
  projectId,
}: {
  projectId: string;
}): Promise<React.JSX.Element | null> {
  if (!utmFeatureOn()) return null;

  const user = await requireUser();
  const access = await requireProjectAccess(user.userId, projectId);

  const [settings, bioLink, project, canManage] = await Promise.all([
    loadLinkTrackingSettings(projectId),
    loadInstagramBioLink(projectId),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { domain: true },
    }),
    isWorkspaceManager(user.userId, access.workspaceId),
  ]);

  const bioDefault = bioDefaultUrl(project?.domain ?? null);

  return (
    <Card size="sm">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
          <Link2 className="size-4 text-primary" />
        </span>
        <CardTitle className="text-base">{LINK_TRACKING_COPY.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <ActionForm
          action={updateLinkTrackingAction}
          successMessage={LINK_TRACKING_COPY.saved}
          className="space-y-4"
        >
          <input type="hidden" name="projectId" value={projectId} />
          <div className="flex items-start gap-3">
            <Switch
              key={`link-tracking-utm-${settings.utmEnabled}`}
              id="link-tracking-utm"
              name="utmEnabled"
              defaultChecked={settings.utmEnabled}
              disabled={!canManage}
            />
            <div className="min-w-0 space-y-1">
              <Label htmlFor="link-tracking-utm">
                {LINK_TRACKING_COPY.toggle}
              </Label>
              <p className="text-xs text-muted-foreground">
                {LINK_TRACKING_COPY.toggleHint}
              </p>
              {canManage ? null : (
                <p className="text-xs text-muted-foreground">
                  {LINK_TRACKING_COPY.managersOnly}
                </p>
              )}
            </div>
          </div>
          {canManage ? (
            <div className="flex justify-end">
              <SubmitButton>Save</SubmitButton>
            </div>
          ) : null}
        </ActionForm>

        {settings.utmEnabled ? (
          <div className="space-y-3 border-t pt-4">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">
                {LINK_TRACKING_COPY.bioTitle}
              </h3>
              <p className="text-xs text-muted-foreground">
                {LINK_TRACKING_COPY.bioHint}
              </p>
            </div>

            {bioLink ? (
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
                  {bioLink.url}
                </code>
                <CopyButton text={bioLink.url} label="Bio link" />
              </div>
            ) : null}

            {bioDefault ? (
              <ActionForm
                action={saveInstagramBioLinkAction}
                successMessage={LINK_TRACKING_COPY.bioSaved}
                className="flex flex-col gap-2 sm:flex-row sm:items-end"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="link-tracking-bio-url">Destination page</Label>
                  <Input
                    id="link-tracking-bio-url"
                    name="destinationUrl"
                    type="url"
                    defaultValue={bioLink?.destinationUrl ?? bioDefault ?? ""}
                    placeholder="https://"
                  />
                </div>
                <SubmitButton variant="outline">
                  {bioLink
                    ? LINK_TRACKING_COPY.bioUpdate
                    : LINK_TRACKING_COPY.bioCreate}
                </SubmitButton>
              </ActionForm>
            ) : (
              <p className="text-xs text-muted-foreground">
                {LINK_TRACKING_COPY.bioNoDomain}
              </p>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
