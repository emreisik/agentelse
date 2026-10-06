import { formatPercent } from "@/lib/module-flows/analytics/format";
import type { LostReason } from "@/lib/seo/redirect-map";
import type { LostUrlReport } from "@/server/seo/health/lost-urls";

// Trafiğini kaybeden sayfalar ve önerilen 301 haritası (SC-F3 SH27). Harita
// her açılışta hesaplanır, saklanmaz; yalnız açık GSC_LOST_URLS uyarısında.

const CARD = "rounded-xl p-4 ring-1 ring-foreground/10";

const REASON_LABEL: Record<LostReason, string> = {
  NOT_FOUND: "Page not found (404)",
  GONE: "Removed (410)",
  SERVER_ERROR: "Server error",
  TO_HOMEPAGE: "Redirects to the homepage",
  TO_UNRELATED: "Redirects to an unrelated page",
  NOINDEX: "Set to noindex",
};

export function RedirectMapCard({ report }: { report: LostUrlReport }) {
  if (report.rows.length === 0) return null;
  return (
    <div className={CARD} data-card="redirect-map">
      <p className="text-sm font-medium">
        Pages that lost their search traffic
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {report.lostClicksShare !== null
          ? `These pages brought ${formatPercent(
              Math.round(report.lostClicksShare * 1000) / 10,
            )} of your clicks before they stopped working.`
          : "These pages brought clicks before they stopped working."}
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Old page</th>
              <th className="py-1.5 pr-3 font-medium">What happened</th>
              <th className="py-1.5 font-medium">Suggested new page</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-foreground/10">
            {report.rows.map((row) => (
              <tr key={row.from}>
                <td className="py-1.5 pr-3 break-all">{row.fromPath}</td>
                <td className="py-1.5 pr-3">{REASON_LABEL[row.reason]}</td>
                <td className="py-1.5 break-all">
                  {row.to ?? (
                    <span className="text-muted-foreground">
                      No close match
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Add these as permanent (301) redirects on your server, from each old
        address to its new page, so people and Google find the new page.
      </p>
      <textarea
        readOnly
        aria-label="Redirect map"
        value={report.text}
        rows={Math.min(10, Math.max(3, report.rows.length))}
        className="mt-2 w-full rounded-lg bg-muted p-2.5 font-mono text-[11px]"
      />
    </div>
  );
}
