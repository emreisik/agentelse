"use client";

import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// TopBar'ın sol tarafında, Araçlar menüsünün yanında — "şu an hangi
// projedesin" sorusuna tek bakışta net cevap versin diye dolgulu/kalın bir
// vurgu alır (soluk çerçeveli varsayılan trigger yerine). Bir proje seçmek
// o projenin köküne (sohbet ekranına) götürür.
export function ProjectSelect({
  projects,
  activeProjectId,
}: {
  projects: { id: string; name: string }[];
  activeProjectId?: string;
}) {
  const router = useRouter();
  const items = projects.map((project) => ({
    value: project.id,
    label: project.name,
  }));

  return (
    <Select
      items={items}
      value={activeProjectId}
      onValueChange={(id) => {
        if (id) router.push(`/projects/${id}`);
      }}
    >
      <SelectTrigger className="h-9 max-w-64 gap-2 rounded-lg border-transparent bg-accent px-3 font-heading text-sm font-semibold text-foreground hover:bg-accent/80 dark:bg-accent/60 dark:hover:bg-accent/80">
        <Building2 className="size-4 shrink-0 text-muted-foreground" />
        <SelectValue placeholder="Proje seçin" />
      </SelectTrigger>
      <SelectContent>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
        {projects.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Henüz proje yok.
          </p>
        ) : null}
      </SelectContent>
    </Select>
  );
}
