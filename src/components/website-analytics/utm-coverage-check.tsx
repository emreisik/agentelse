import { MeasurementDot } from "@/components/website-analytics/measurement-score";
import { gaAttributionEnabledFor } from "@/lib/website-analytics/attribution/flags";
import {
  MH25_KEY,
  UTM_COVERAGE_GUIDE,
  utmCoverageText,
  utmCoverageTitle,
} from "@/lib/website-analytics/health/utm-coverage";
import { loadUtmCoverageCheck } from "@/server/website-analytics/health/utm-coverage";

// "Measurement health" panelinin hemen altındaki MH25 kartı (GA-F6): Agentelse
// reklam linklerinin etiket kapsamı. Her görüntülemede yeniden hesaplanır;
// bu yüzden "I fixed it" ve sessize alma yok. Bayrak kapalıyken sorgusuz null.
// WARN: uyarı kartı; PASS: tek soluk satır; UNKNOWN ya da hata: hiçbir şey.
// Sunucuda çizilir, tek sütun, mobil önce.

const TITLE_ID = "utm-coverage-title";

export async function UtmCoverageCheck({
  projectId,
}: {
  projectId: string;
}): Promise<React.JSX.Element | null> {
  if (!gaAttributionEnabledFor(projectId)) return null;
  const result = await loadUtmCoverageCheck(projectId);
  if (!result || result.status === "UNKNOWN") return null;

  if (result.status === "PASS") {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <MeasurementDot tone="unknown" />
        <span>
          {MH25_KEY} · {utmCoverageTitle(result)}
        </span>
      </p>
    );
  }

  return (
    <section
      id="utm-coverage"
      aria-labelledby={TITLE_ID}
      className="space-y-2 rounded-xl p-4 ring-1 ring-foreground/10"
    >
      <div className="flex items-center gap-2">
        <MeasurementDot tone="unknown" />
        <h3 id={TITLE_ID} className="text-sm font-medium">
          {utmCoverageTitle(result)}
        </h3>
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="mr-1.5 inline-flex rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          Code {MH25_KEY}
        </span>
        {utmCoverageText(result)}
      </p>
      <details className="group text-xs">
        <summary className="cursor-pointer font-medium text-foreground select-none">
          How to fix
        </summary>
        <div className="mt-2 space-y-2 text-muted-foreground">
          <p className="font-medium text-foreground">{UTM_COVERAGE_GUIDE.title}</p>
          <ol className="list-decimal space-y-1 pl-4">
            {UTM_COVERAGE_GUIDE.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </details>
    </section>
  );
}
