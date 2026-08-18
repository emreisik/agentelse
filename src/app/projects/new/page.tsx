import { AppShell } from "@/components/layout/app-shell";
import { NewProjectWizard } from "@/components/projects/new-project-wizard";

export default function NewProjectPage() {
  return (
    <AppShell>
      <div className="flex h-full flex-col items-center justify-center gap-8 overflow-y-auto p-6">
        <p className="text-sm font-medium text-muted-foreground">
          Yeni Proje Oluştur
        </p>
        <NewProjectWizard />
      </div>
    </AppShell>
  );
}
