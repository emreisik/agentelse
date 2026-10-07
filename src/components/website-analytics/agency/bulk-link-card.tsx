"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Link2 } from "lucide-react";
import { toast } from "sonner";

import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { bulkLinkGoogleAccountAction } from "@/server/actions/website-agency-actions";

// "Link a Google account to many projects" (GA-F8, /websites): bir Google
// hesabının bağlantısı tek işlemde en çok 20 projeye kopyalanır (yeni OAuth ve
// yeni token yok). Seçim sınırı sunucuda da zorlanır; burada yalnız kolaylık.

const MAX_PROJECTS = 20;

type ActionState = { ok: boolean; message: string; seq: number } | null;

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-auto";

export function BulkLinkCard({
  accounts,
  projects,
}: {
  accounts: { credentialId: string; email: string; projectCount: number }[];
  projects: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [state, formAction] = useActionState(
    async (_previous: ActionState, formData: FormData): Promise<ActionState> => {
      try {
        const result = await bulkLinkGoogleAccountAction(formData);
        if (result.ok) setSelected([]);
        return { ok: result.ok, message: result.message, seq: Date.now() };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Action failed",
          seq: Date.now(),
        };
      }
    },
    null,
  );

  const lastSeq = useRef(0);
  useEffect(() => {
    if (!state || state.seq === lastSeq.current) return;
    lastSeq.current = state.seq;
    if (state.ok) {
      toast.success(state.message);
      router.refresh();
    } else {
      toast.error(state.message);
    }
  }, [state, router]);

  if (accounts.length === 0 || projects.length === 0) return null;

  const full = selected.length >= MAX_PROJECTS;
  const toggle = (id: string, checked: boolean) =>
    setSelected((current) =>
      checked
        ? current.includes(id) || current.length >= MAX_PROJECTS
          ? current
          : [...current, id]
        : current.filter((value) => value !== id),
    );

  return (
    <Card size="sm">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
          <Link2 className="size-4 text-primary" />
        </span>
        <CardTitle className="text-base">
          Link a Google account to projects
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Uses the connection you already made: no new sign-in and no new
            access token. Pick up to {MAX_PROJECTS} projects.
          </p>
          <select
            name="sourceCredentialId"
            required
            defaultValue={accounts[0]?.credentialId}
            className={selectClass}
            aria-label="Google account"
          >
            {accounts.map((account) => (
              <option key={account.credentialId} value={account.credentialId}>
                {account.email} ({account.projectCount}{" "}
                {account.projectCount === 1 ? "project" : "projects"})
              </option>
            ))}
          </select>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {selected.length} of {MAX_PROJECTS} selected
              </span>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSelected(projects.slice(0, MAX_PROJECTS).map((p) => p.id))
                  }
                >
                  Select first {MAX_PROJECTS}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected([])}
                  disabled={selected.length === 0}
                >
                  Clear
                </Button>
              </div>
            </div>
            <ul className="grid max-h-64 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
              {projects.map((project) => {
                const checked = selected.includes(project.id);
                return (
                  <li key={project.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50">
                      <input
                        type="checkbox"
                        name="projectId"
                        value={project.id}
                        checked={checked}
                        disabled={!checked && full}
                        onChange={(event) =>
                          toggle(project.id, event.target.checked)
                        }
                      />
                      <span className="truncate">{project.name}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="autoProperty"
              defaultChecked={false}
              className="mt-1"
            />
            <span>
              Pick the property automatically when the name matches
              <span className="block text-xs text-muted-foreground">
                Check the result: a wrong match would show another
                client&apos;s data.
              </span>
            </span>
          </label>

          {state && !state.ok ? (
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
          ) : null}
          {state?.ok ? (
            <p role="status" className="text-sm text-muted-foreground">
              {state.message}
            </p>
          ) : null}

          <SubmitButton size="sm" disabled={selected.length === 0}>
            Link {selected.length > 0 ? selected.length : ""} project
            {selected.length === 1 ? "" : "s"}
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}
