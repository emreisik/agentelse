import Link from "next/link";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { cn } from "@/lib/utils";
import type { GaPropertyChip } from "@/lib/website-analytics/agency/properties";
import {
  addGaPropertyAction,
  makeGaPropertyMainAction,
  removeGaPropertyAction,
} from "@/server/actions/website-property-actions";

// GA-F8 mülk seçici (Website sayfası, başlığın altında): ana mülk ve ekler
// çip olarak sıralanır, çip ?property= ile aynı sayfayı o mülkle açar.
// Yöneticiler için "Manage" bölümü: mülk ekle, ekten kaldır, ana mülk yap.
// Sunucuda çizilir; yalnız ActionForm/SubmitButton istemci bileşeni.

const SELECT_CLASS =
  "h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-xs";

function Hidden({
  projectId,
  propertyId,
}: {
  projectId: string;
  propertyId?: string;
}) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      {propertyId ? (
        <input type="hidden" name="propertyId" value={propertyId} />
      ) : null}
    </>
  );
}

export function PropertySwitcher({
  projectId,
  chips,
  canManage,
  addable,
  canAdd,
}: {
  projectId: string;
  chips: GaPropertyChip[];
  canManage: boolean;
  addable: { propertyId: string; label: string }[];
  canAdd: boolean;
}) {
  // Tek mülk ve yönetici değilse gösterecek bir şey yok.
  if (chips.length <= 1 && !canManage) return null;
  const extras = chips.filter((chip) => chip.role === "extra");

  return (
    <nav aria-label="Google Analytics properties" className="space-y-2">
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <Link
              key={chip.linkId}
              href={chip.href}
              aria-current={chip.selected ? "page" : undefined}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                chip.selected
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="truncate">{chip.label}</span>
              {chip.role === "extra" ? (
                <span className="rounded-full bg-background/20 px-1.5 text-[10px]">
                  Extra
                </span>
              ) : null}
              {chip.serviceLevel === "360" ? (
                <span className="rounded-full bg-background/20 px-1.5 text-[10px]">
                  360
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      ) : null}

      {canManage ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground select-none">
            Manage
          </summary>
          <div className="mt-2 space-y-3 rounded-xl p-3 ring-1 ring-foreground/10">
            {canAdd && addable.length > 0 ? (
              <ActionForm
                action={addGaPropertyAction}
                successMessage="Property added. Data arrives within a few minutes."
                className="flex flex-wrap items-center gap-2"
              >
                <Hidden projectId={projectId} />
                <select
                  name="propertyId"
                  aria-label="Property to add"
                  defaultValue={addable[0]?.propertyId}
                  className={SELECT_CLASS}
                >
                  {addable.map((option) => (
                    <option key={option.propertyId} value={option.propertyId}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <SubmitButton variant="outline" size="xs">
                  Add property
                </SubmitButton>
              </ActionForm>
            ) : (
              <p className="text-muted-foreground">
                {canAdd
                  ? "Every property this Google account can see is already linked."
                  : "You can add up to 4 extra properties."}
              </p>
            )}
            {extras.length > 0 ? (
              <ul className="divide-y divide-foreground/10">
                {extras.map((chip) => (
                  <li
                    key={chip.linkId}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                  >
                    <span className="min-w-0 truncate font-medium">
                      {chip.label}
                    </span>
                    <div className="flex items-center gap-2">
                      <ActionForm
                        action={makeGaPropertyMainAction}
                        successMessage="Main property changed"
                      >
                        <Hidden
                          projectId={projectId}
                          propertyId={chip.propertyId}
                        />
                        <SubmitButton variant="outline" size="xs">
                          Make main
                        </SubmitButton>
                      </ActionForm>
                      <ActionForm
                        action={removeGaPropertyAction}
                        successMessage="Property removed"
                      >
                        <Hidden
                          projectId={projectId}
                          propertyId={chip.propertyId}
                        />
                        <SubmitButton variant="ghost" size="xs">
                          Remove
                        </SubmitButton>
                      </ActionForm>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-muted-foreground">
              Extra properties get their own reports and checks. Removing one
              also deletes its reports and shared links.
            </p>
          </div>
        </details>
      ) : null}
    </nav>
  );
}
