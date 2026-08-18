"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClipboardCheck, HeartPulse, Plus, UserRoundCog } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ProjectSelect } from "@/components/layout/project-select";
import { ProjectToolsMenu } from "@/components/hub-core/project-tools-menu";
import {
  buildHubHref,
  type PanelKey,
} from "@/components/hub-core/hub-core-params";
import { cn } from "@/lib/utils";

export function TopBar({
  projects,
  pendingApprovals,
  pendingHumanActions,
  systemErrors,
  toolBadges,
}: {
  projects: { id: string; name: string; status: string }[];
  pendingApprovals: number;
  pendingHumanActions: number;
  systemErrors: number;
  toolBadges: Partial<Record<PanelKey, number>>;
}) {
  const pathname = usePathname();
  const activeProject = projects.find((project) =>
    pathname.startsWith(`/projects/${project.id}`),
  );
  // Proje bağlamında topbar ChatGPT'nin minimal, kenarlıksız üst şeridine
  // yaklaşır — workspace geneli sayfalarda mevcut çerçeveli görünüm korunur.
  // Proje listesi artık sidebar'da olduğu için burada tekrar edilmiyor —
  // sadece aktif projenin adı gösteriliyor.
  const minimal = Boolean(activeProject);

  return (
    <header
      className={cn(
        "flex h-16 shrink-0 items-center justify-between bg-background px-6",
        !minimal && "border-b border-border",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {activeProject ? (
          <ProjectSelect
            projects={projects}
            activeProjectId={activeProject.id}
          />
        ) : null}
        {activeProject ? (
          <ProjectToolsMenu projectId={activeProject.id} badges={toolBadges} />
        ) : null}
      </div>

      <div className="flex items-center gap-1.5">
        <TopBarAction
          href={
            activeProject
              ? buildHubHref(activeProject.id, { panel: "onaylar" })
              : "/approvals"
          }
          icon={ClipboardCheck}
          label="onay"
          count={activeProject ? (toolBadges.onaylar ?? 0) : pendingApprovals}
        />
        <TopBarAction
          href={
            activeProject
              ? buildHubHref(activeProject.id, { panel: "insan-eylem" })
              : "/human-actions"
          }
          icon={UserRoundCog}
          label="eylem"
          count={
            activeProject
              ? (toolBadges["insan-eylem"] ?? 0)
              : pendingHumanActions
          }
        />
        <TopBarAction
          href="/saglik"
          icon={HeartPulse}
          label="hata"
          count={systemErrors}
        />
        <Button
          render={<Link href="/projects/new" />}
          nativeButton={false}
          size="sm"
          className="ml-1 gap-1.5"
        >
          <Plus className="size-4" />
          Yeni proje
        </Button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------

// Proje içindeyken de (üstteki minimal topbar) proje dışındaki (workspace
// geneli) sayfalarla BİREBİR aynı görünüm: ikon + sayı + etiket metni, sade
// ghost buton — iki bağlam için ayrı bir stil YOK.
function TopBarAction({
  href,
  icon: Icon,
  label,
  count,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
}) {
  return (
    <Button
      render={<Link href={href} />}
      nativeButton={false}
      variant="ghost"
      size="sm"
      className="gap-1.5 text-muted-foreground"
    >
      <Icon className="size-4" />
      {count} {label}
    </Button>
  );
}
