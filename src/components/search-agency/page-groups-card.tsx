import { Badge } from "@/components/ui/badge";
import { PAGE_GROUP_MATCH_LABEL } from "@/lib/seo/agency/copy";
import type { PageGroupState } from "@/server/seo/agency/page-groups";

import {
  ADMIN_HINT,
  BODY_CLASS,
  DETAILS_CLASS,
  HINT_CLASS,
  SUMMARY_CLASS,
} from "./form-helpers";
import { PageGroupsEditor } from "./page-groups-editor";

// Search sayfasındaki "Page groups" kartı (SC-F9): sayfaları ilk yol parçası
// yerine kendi kurallarınla gruplamak (ör. /shop/*/reviews). Kurallar
// kaydedilince mevcut sayfalara arka planda uygulanır. Yönetmeyen
// kullanıcılar kuralları salt okunur görür.

export function PageGroupsCard({
  projectId,
  linkId,
  state,
  groups,
  isManager,
}: {
  projectId: string;
  linkId: string;
  state: PageGroupState;
  groups: { group: string; pages: number }[];
  isManager: boolean;
}) {
  const rules = state.rules.rules;
  return (
    <details data-card="agency-page-groups" className={DETAILS_CLASS}>
      <summary className={SUMMARY_CLASS}>
        <span>Page groups</span>
        <span className="text-xs font-normal tabular-nums text-muted-foreground">
          {rules.length === 0
            ? "By first path segment"
            : `${rules.length} ${rules.length === 1 ? "rule" : "rules"}`}
        </span>
      </summary>
      <div className={BODY_CLASS}>
        <p className="text-sm text-muted-foreground">
          Groups let you compare and test sets of similar pages, like all
          product pages or all reviews. Without rules, a page belongs to the
          group named after its first path segment.
        </p>
        {state.applying ? (
          <p
            role="status"
            data-state="applying"
            className="rounded-xl bg-muted p-3 text-sm"
          >
            Applying to your pages...
            <span className={`${HINT_CLASS} block`}>
              Existing pages are regrouped in the background. Numbers by group
              can look mixed until it finishes.
            </span>
          </p>
        ) : null}
        {groups.length > 0 ? (
          <div className="space-y-1">
            <p className={HINT_CLASS}>Current groups</p>
            <ul className="flex flex-wrap gap-1.5">
              {groups.slice(0, 20).map((group) => (
                <li key={group.group}>
                  <Badge variant="outline" className="tabular-nums">
                    {group.group} · {group.pages}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {isManager ? (
          <PageGroupsEditor
            projectId={projectId}
            linkId={linkId}
            initialRules={rules}
          />
        ) : (
          <div className="space-y-2" data-state="read-only">
            {rules.length > 0 ? (
              <ol className="space-y-1 text-sm">
                {rules.map((rule) => (
                  <li key={rule.id} className="flex flex-wrap gap-x-2">
                    <span className="font-medium">{rule.group}</span>
                    <span className="text-muted-foreground">
                      {PAGE_GROUP_MATCH_LABEL[rule.match]}
                    </span>
                    <code className="text-xs">{rule.pattern}</code>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">No rules yet.</p>
            )}
            <p className={HINT_CLASS}>{ADMIN_HINT}</p>
          </div>
        )}
      </div>
    </details>
  );
}
