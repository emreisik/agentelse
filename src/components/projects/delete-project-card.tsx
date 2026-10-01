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
      // On success the action redirects and never returns here.
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
        <CardTitle className="text-base">Danger zone</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 text-sm">
          <p>
            Deleting the project permanently removes{" "}
            <strong>{totalRows.toLocaleString("tr-TR")}</strong> records. This
            action cannot be undone and does not create a backup.
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
            Records in external systems such as connected social accounts and ad
            platforms are not deleted — you need to remove those from the
            relevant tool.
          </p>
        </div>

        {!armed ? (
          <button
            type="button"
            onClick={() => setArmed(true)}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-destructive ring-1 ring-destructive/40 transition-colors hover:bg-destructive/10"
          >
            Delete project
          </button>
        ) : (
          <form action={formAction} className="space-y-3">
            <input type="hidden" name="projectId" value={projectId} />
            <label className="block space-y-1.5">
              <span className="text-sm">
                Type the project name to confirm:{" "}
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
                Delete permanently
              </SubmitButton>
              <button
                type="button"
                onClick={() => {
                  setArmed(false);
                  setConfirmation("");
                }}
                className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
