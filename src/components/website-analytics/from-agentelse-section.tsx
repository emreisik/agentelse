import { gaAttributionEnabledFor } from "@/lib/website-analytics/attribution/flags";
import {
  fromAgentelseTable,
  googleAdsTable,
  metaVsGaTable,
} from "@/lib/website-analytics/attribution/view-format";
import { AttributionTableCard } from "@/components/website-analytics/attribution-tables";
import { loadWebsiteAttribution } from "@/server/website-analytics/attribution/read";

// GA-F6: Website sayfasındaki "From Agentelse" ve "Your ads on your website"
// bölümleri. Bayrak kapalıyken sorgusuz null döner; hata sayfayı bozmaz.
export async function FromAgentelseSection({
  projectId,
  range,
}: {
  projectId: string;
  range: { from: string; to: string };
}): Promise<React.JSX.Element | null> {
  if (!gaAttributionEnabledFor(projectId)) return null;
  const view = await loadWebsiteAttribution(projectId, range).catch(() => null);
  if (!view) return null;
  const from = view.from ? fromAgentelseTable(view.from) : null;
  const meta = view.ads?.meta ? metaVsGaTable(view.ads.meta) : null;
  const googleAds = view.ads?.googleAds
    ? googleAdsTable(view.ads.googleAds)
    : null;
  if (!from && !meta && !googleAds) return null;
  return (
    <section id="from-agentelse" className="space-y-4">
      {from ? <AttributionTableCard table={from} /> : null}
      {meta ? <AttributionTableCard table={meta} /> : null}
      {googleAds ? <AttributionTableCard table={googleAds} /> : null}
    </section>
  );
}
