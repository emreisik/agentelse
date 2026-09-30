import { headers } from "next/headers";

import { AppShell } from "@/components/layout/app-shell";
import { NewProjectForm } from "@/components/projects/new-project-form";
import { NewProjectWizard } from "@/components/projects/new-project-wizard";
import { getEnv } from "@/lib/env";
import { pickLocaleDefault, type LocaleDefault } from "@/lib/locale-defaults";
import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";

// The guided-setup flag picks the screen: off renders the untouched four-step
// wizard (which posts to the untouched createProjectAction), on renders the
// one-screen form. The flag is read here, at request time.
export default async function NewProjectPage() {
  const guided = getEnv().GUIDED_SETUP;

  // The ccTLD rung of the ladder runs in the browser from the typed website;
  // the server contributes the two rungs only it can see.
  let initialLocale: LocaleDefault = null;
  if (guided) {
    const { userId } = await requireUser();
    const { workspaceId } = await requireWorkspaceMembership(userId);
    const [previous, requestHeaders] = await Promise.all([
      prisma.project.findFirst({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
        select: { language: true, country: true },
      }),
      headers(),
    ]);
    initialLocale = pickLocaleDefault({
      previous,
      acceptLanguage: requestHeaders.get("accept-language"),
    });
  }

  return (
    <AppShell>
      <div className="flex h-full flex-col items-center justify-center gap-8 overflow-y-auto p-6">
        <p className="text-sm font-medium text-muted-foreground">
          Create New Project
        </p>
        {guided ? (
          <NewProjectForm initialLocale={initialLocale} />
        ) : (
          <NewProjectWizard />
        )}
      </div>
    </AppShell>
  );
}
