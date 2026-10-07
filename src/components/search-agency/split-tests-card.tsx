import {
  OPEN_SPLIT_STATUSES,
  type SplitTestView,
} from "@/lib/seo/agency/split/types";

import { BODY_CLASS, DETAILS_CLASS, SUMMARY_CLASS } from "./form-helpers";
import { SplitTestForm } from "./split-test-form";
import { SplitTestList } from "./split-test-list";

// Search sayfasındaki "Split SEO tests" kartı (SC-F9): benzer sayfaları
// rastgele iki yarıya böl, değişikliği yalnız test yarısına uygula, farkı
// ölç. Karta yalnız yönetici değil her proje üyesi erişir (eylemler kendi
// izinlerini sunucuda denetler); CMS yolu yalnız yöneticiye çalışır.

export function SplitTestsCard({
  projectId,
  linkId,
  tests,
  groups,
  applyReady,
}: {
  projectId: string;
  linkId: string;
  tests: SplitTestView[];
  groups: { group: string; pages: number }[];
  applyReady: boolean;
}) {
  const open = tests.filter((test) =>
    OPEN_SPLIT_STATUSES.includes(test.status),
  );
  return (
    <details data-card="agency-split-tests" className={DETAILS_CLASS}>
      <summary className={SUMMARY_CLASS}>
        <span>Split SEO tests</span>
        <span className="text-xs font-normal tabular-nums text-muted-foreground">
          {open.length > 0
            ? `${open.length} open`
            : tests.length > 0
              ? `${tests.length} finished`
              : "None yet"}
        </span>
      </summary>
      <div className={BODY_CLASS}>
        <p className="text-sm text-muted-foreground">
          Change half of a set of similar pages and compare them with the other
          half. Results come from your Search Console numbers, so a clear answer
          takes a few weeks.
        </p>
        <SplitTestList
          projectId={projectId}
          tests={tests}
          applyReady={applyReady}
        />
        <div className="space-y-2 border-t border-foreground/10 pt-4">
          <h3 className="text-sm font-semibold">New split test</h3>
          <SplitTestForm
            projectId={projectId}
            linkId={linkId}
            groups={groups}
          />
        </div>
      </div>
    </details>
  );
}
