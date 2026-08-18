"use client";

import { useActionState, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";

import { deleteProjectAction } from "@/server/actions/project-deletion-actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type State = { ok: true } | { ok: false; message: string } | null;

export function DeleteProjectCard({
  projectId,
  projectName,
  totalRows,
  topTables,
}: {
  projectId: string;
  projectName: string;
  totalRows: number;
  topTables: Array<{ table: string; count: number }>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [armed, setArmed] = useState(false);

  const [, formAction] = useActionState(
    async (_prev: State, form: FormData) => {
      const result = await deleteProjectAction(form);
      // Başarı hâlinde aksiyon yönlendirme yapar ve buraya hiç dönmez.
      if (result && !result.ok) toast.error(result.message);
      return result as State;
    },
    null,
  );

  const matches = confirmation === projectName;

  return (
    <Card className="ring-1 ring-destructive/30">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-destructive/15">
          <AlertTriangle className="size-4 text-destructive" />
        </span>
        <CardTitle className="text-base">Tehlikeli bölge</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 text-sm">
          <p>
            Projeyi silmek <strong>{totalRows.toLocaleString("tr-TR")}</strong>{" "}
            kaydı kalıcı olarak kaldırır. Bu işlem geri alınamaz ve yedek
            oluşturmaz.
          </p>
          {topTables.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
              {topTables.map((row) => (
                <li
                  key={row.table}
                  className="rounded-lg bg-accent/60 px-2 py-1"
                >
                  {row.table}: {row.count}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-muted-foreground">
            OpenClaw ajanı, tarayıcı oturumları ve bağlı sosyal hesaplar gibi
            dış sistemlerdeki kayıtlar silinmez — onları ilgili araçtan
            kaldırmanız gerekir.
          </p>
        </div>

        {!armed ? (
          <button
            type="button"
            onClick={() => setArmed(true)}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-destructive ring-1 ring-destructive/40 transition-colors hover:bg-destructive/10"
          >
            Projeyi sil
          </button>
        ) : (
          <form action={formAction} className="space-y-3">
            <input type="hidden" name="projectId" value={projectId} />
            <label className="block space-y-1.5">
              <span className="text-sm">
                Onaylamak için proje adını yazın:{" "}
                <strong className="font-mono">{projectName}</strong>
              </span>
              <Input
                name="confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={projectName}
                autoComplete="off"
              />
            </label>
            <div className="flex gap-2">
              <SubmitButton size="sm" variant="destructive" disabled={!matches}>
                Kalıcı olarak sil
              </SubmitButton>
              <button
                type="button"
                onClick={() => {
                  setArmed(false);
                  setConfirmation("");
                }}
                className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                Vazgeç
              </button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
