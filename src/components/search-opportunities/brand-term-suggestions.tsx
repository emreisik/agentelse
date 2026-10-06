import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import {
  acceptBrandTermSuggestionAction,
  dismissBrandTermSuggestionAction,
  suggestBrandTermsAction,
} from "@/server/actions/search-opportunity-actions";
import {
  readBrandTermSuggestions,
  type BrandTermSuggestion,
} from "@/server/seo/opportunities/brand-suggest";

// Marka terimleri formunun altındaki öneriler (SC-F4, SK8 a): aramalardan
// önerilen marka yazımları kullanıcı onayıyla eklenir. SEO_INSIGHTS=on ve
// proje izinli değilken readBrandTermSuggestions veritabanına gitmeden null
// döner ve hiçbir şey çizilmez.

export function BrandTermSuggestionsView({
  projectId,
  items,
}: {
  projectId: string;
  items: readonly BrandTermSuggestion[];
}): React.JSX.Element {
  return (
    <div
      className="space-y-2 border-t border-foreground/10 pt-3"
      data-brand-suggestions={items.length}
    >
      {items.length > 0 ? (
        <>
          <p className="text-xs font-medium">Suggested brand terms</p>
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li
                key={item.term}
                className="flex flex-wrap items-center gap-x-2 gap-y-1"
              >
                <span className="text-xs font-medium">{item.term}</span>
                {item.reason ? (
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {item.reason}
                  </span>
                ) : null}
                <div className="flex items-center gap-1">
                  <ActionForm
                    action={acceptBrandTermSuggestionAction}
                    successMessage="Brand term added. Brand and non-brand clicks update with the next sync."
                  >
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="term" value={item.term} />
                    <SubmitButton size="xs" variant="outline">
                      Add
                    </SubmitButton>
                  </ActionForm>
                  <ActionForm
                    action={dismissBrandTermSuggestionAction}
                    successMessage="Dismissed"
                  >
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="term" value={item.term} />
                    <SubmitButton size="xs" variant="ghost">
                      Dismiss
                    </SubmitButton>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          We can look at your searches and suggest spellings of your brand.
        </p>
      )}
      <ActionForm
        action={suggestBrandTermsAction}
        successMessage="Looking at your searches for brand terms…"
        className="flex justify-end"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <SubmitButton size="xs" variant="outline">
          Suggest terms
        </SubmitButton>
      </ActionForm>
    </div>
  );
}

export async function BrandTermSuggestions({
  projectId,
}: {
  projectId: string;
}): Promise<React.JSX.Element | null> {
  const items = await readBrandTermSuggestions(projectId).catch(() => null);
  if (!items) return null;
  return <BrandTermSuggestionsView projectId={projectId} items={items} />;
}
