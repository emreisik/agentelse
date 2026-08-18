"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ClipboardCheck,
  FolderKanban,
  HeartPulse,
  Plus,
  Search,
  UserRoundCog,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { cn, statusBadgeVariant } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const PROJECT_STATUS_LABELS: Record<string, string> = {
  CREATED: "Oluşturuldu",
  DISCOVERY: "Keşif",
  NEEDS_INFORMATION: "Bilgi Gerekli",
  PROFILE_REVIEW: "Profil İncelemesi",
  NEEDS_ASSESSMENT: "Değerlendirme Gerekli",
  STRATEGY: "Strateji",
  ACTIVE: "Aktif",
  PAUSED: "Duraklatıldı",
  CLOSED: "Kapatıldı",
};

type ProjectItem = { id: string; name: string; status: string };

// Dashboard'daki büyük, ChatGPT tarzı "arama/komut" çubuğu — tıklanınca
// cmdk tabanlı bir komut paletine açılır: projeler arasında ara ya da
// sık kullanılan işlemlere (yeni proje, onaylar, insan eylemleri, sistem
// sağlığı) tek tuşla atla. Cmd/Ctrl+K ile de açılır.
export function DashboardCommandBar({ projects }: { projects: ProjectItem[] }) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-14 w-full items-center gap-3 rounded-2xl border border-border bg-card px-5 text-left shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-muted/30 dark:shadow-none",
        )}
      >
        <Search className="size-4.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm text-muted-foreground">
          Bir proje arayın ya da bir işlem yapın…
        </span>
        <kbd className="hidden shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground sm:flex">
          <span className="text-xs">⌘</span>K
        </kbd>
      </button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Komut paleti"
        description="Proje arayın ya da bir işlem seçin"
      >
        <CommandInput placeholder="Proje arayın ya da bir işlem yazın…" />
        <CommandList>
          <CommandEmpty>Sonuç bulunamadı.</CommandEmpty>
          {projects.length > 0 ? (
            <CommandGroup heading="Projeler">
              {projects.map((project) => (
                <CommandItem
                  key={project.id}
                  value={project.name}
                  onSelect={() => go(`/projects/${project.id}`)}
                >
                  <FolderKanban className="text-muted-foreground" />
                  <span className="truncate">{project.name}</span>
                  <Badge
                    variant={statusBadgeVariant(project.status)}
                    className="ml-auto text-[10px]"
                  >
                    {PROJECT_STATUS_LABELS[project.status] ?? project.status}
                  </Badge>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          <CommandSeparator />
          <CommandGroup heading="Hızlı işlemler">
            <CommandItem
              value="yeni proje"
              onSelect={() => go("/projects/new")}
            >
              <Plus className="text-muted-foreground" />
              Yeni proje oluştur
            </CommandItem>
            <CommandItem value="onaylar" onSelect={() => go("/approvals")}>
              <ClipboardCheck className="text-muted-foreground" />
              Onayları görüntüle
              <CommandShortcut>Onaylar</CommandShortcut>
            </CommandItem>
            <CommandItem
              value="insan eylemleri"
              onSelect={() => go("/human-actions")}
            >
              <UserRoundCog className="text-muted-foreground" />
              İnsan eylemlerini görüntüle
            </CommandItem>
            <CommandItem value="sistem sagligi" onSelect={() => go("/saglik")}>
              <HeartPulse className="text-muted-foreground" />
              Sistem sağlığını görüntüle
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
