import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { gaEditStartHref } from "@/lib/website-analytics/fixes/consent-copy";
import { turnOffGaEditAccessAction } from "@/server/actions/ga-fix-actions";

// Integrations > Google Analytics penceresindeki isteğe bağlı düzenleme izni
// kartı (GA-F7, docs/website-fixes.md). Yalnız OWNER/ADMIN izin verir ya da
// kapatır. Sunucuda çizilir.

export const GA_REMOVE_AT_GOOGLE_NOTE =
  "Agentelse stops making changes right away. To also remove the permission at Google, remove Agentelse in your Google Account settings (Security, third-party access).";

// Panel ile kart aynı kapatma formunu kullanır.
export function TurnOffEditingForm({ projectId }: { projectId: string }) {
  return (
    <ActionForm
      action={turnOffGaEditAccessAction}
      successMessage="Agentelse will not make changes any more."
      className="space-y-1.5"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <SubmitButton variant="outline" size="xs">
        Turn off editing
      </SubmitButton>
      <p className="text-xs text-muted-foreground">
        {GA_REMOVE_AT_GOOGLE_NOTE}
      </p>
    </ActionForm>
  );
}

export function GaEditAccessCard({
  projectId,
  state,
  canManage,
  justGranted,
}: {
  projectId: string;
  state: "granted" | "not_granted";
  canManage: boolean;
  justGranted?: boolean;
}) {
  return (
    <section
      aria-label="Let Agentelse make approved changes"
      className="space-y-2 rounded-xl p-4 ring-1 ring-foreground/10"
    >
      <h3 className="font-heading text-sm font-semibold">
        Let Agentelse make approved changes (optional)
      </h3>
      <p className="text-xs text-muted-foreground">
        Agentelse reads your Google Analytics. If you want, it can also make
        small fixes in your property, such as marking a key event. Each change
        still needs approval from a workspace owner or admin, and you can undo
        most of them.
      </p>
      {justGranted ? (
        <p className="text-xs font-medium text-success">
          Editing is allowed now.
        </p>
      ) : null}
      {state === "granted" ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Editing allowed</p>
          {canManage ? <TurnOffEditingForm projectId={projectId} /> : null}
        </div>
      ) : canManage ? (
        <a
          href={gaEditStartHref(projectId)}
          className={cn(buttonVariants({ variant: "outline", size: "xs" }))}
        >
          Allow editing
        </a>
      ) : (
        <p className="text-xs text-muted-foreground">
          Only workspace owners and admins can allow editing.
        </p>
      )}
    </section>
  );
}
