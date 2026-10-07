import { AiTrafficCard } from "@/components/search-geo/ai-traffic-card";
import { LlmsDraft } from "@/components/search-geo/llms-draft";
import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { timeAgo } from "@/lib/dates";
import {
  GEO_LLMS_INSTRUCTION,
  GEO_STATUS_LABEL,
  GEO_TRAINING_NOTE,
} from "@/lib/seo/geo/catalog";
import type { GeoStatus } from "@/lib/seo/geo/types";
import type { GeoCheckView, GeoPanel } from "@/lib/seo/geo/view-types";
import { cn } from "@/lib/utils";
import {
  acknowledgeGeoCheckAction,
  auditGeoNowAction,
} from "@/server/actions/seo-geo-actions";

// Search sayfasındaki "AI search visibility" bölümünün gövdesi (SC-F8,
// docs/ai-search-visibility.md): puan, kontrol listesi, "Your decision"
// tarayıcı tablosu, llms.txt taslağı ve (varsa) AI trafiği. Yalnız props'tan
// çizilir (kancasız sunucu bileşeni); tek duyarlı düzen, mobil önce. Agentelse
// siteye ya da robots.txt'e hiçbir şey yazmaz; yalnız bilgi verir.

const CARD = "rounded-xl p-4 ring-1 ring-foreground/10";
export const GEO_TITLE_ID = "ai-visibility-title";

function scoreTone(value: number | null): string {
  if (value === null) return "bg-muted text-muted-foreground";
  if (value >= 80)
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  if (value >= 50) return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "bg-rose-500/10 text-rose-700 dark:text-rose-400";
}

function statusTone(status: GeoStatus): string {
  switch (status) {
    case "PASS":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "WARN":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function StatusChip({ status }: { status: GeoStatus }) {
  return (
    <span
      data-status={status}
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        statusTone(status),
      )}
    >
      {GEO_STATUS_LABEL[status]}
    </span>
  );
}

function Header({ panel }: { panel: GeoPanel }) {
  const delta =
    panel.score !== null && panel.previousScore !== null
      ? panel.score - panel.previousScore
      : null;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={GEO_TITLE_ID} className="font-heading text-base font-semibold">
          AI search visibility
        </h2>
        {panel.state === "ready" ? (
          <span
            data-score={panel.score ?? ""}
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
              scoreTone(panel.score),
            )}
          >
            AI visibility {panel.score === null ? "—" : `${panel.score}/100`}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        How easily AI assistants and search engines can read, understand and
        quote your website. Agentelse reads your public pages and never changes
        your site.
      </p>
      {panel.state === "ready" ? (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {panel.auditedAt ? <span>Checked {timeAgo(panel.auditedAt)}</span> : null}
          {delta !== null && delta !== 0 ? (
            <span>
              {delta > 0 ? "Up" : "Down"} {Math.abs(delta)} since the check
              before
            </span>
          ) : null}
          {panel.recommendationSource === "ai" ? (
            <span>Tips written by AI from these results</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AckForm({
  projectId,
  checkId,
  on,
}: {
  projectId: string;
  checkId: string;
  on: boolean;
}) {
  return (
    <ActionForm
      action={acknowledgeGeoCheckAction}
      successMessage={on ? "Saved as your decision" : "Counted again"}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="on" value={on ? "true" : "false"} />
      <SubmitButton variant="outline" size="xs">
        {on ? "I decided this" : "Count it again"}
      </SubmitButton>
    </ActionForm>
  );
}

function listOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

// Kontrolün kısa olgu satırı (yalnız sitenin kendi sayıları ve belirteçler).
function factsLine(check: GeoCheckView): string | null {
  const { id, facts } = check;
  const blocked = listOf(facts.blocked);
  if ((id === "GEO2" || id === "GEO3") && blocked.length > 0) {
    return `Blocked: ${blocked.join(", ")}`;
  }
  if (id === "GEO8" && typeof facts.contentPages === "number") {
    return `${facts.withQuestionHeadings} of ${facts.contentPages} content pages have a question heading`;
  }
  if (id === "GEO9" && typeof facts.snippetBlocked === "number") {
    return facts.snippetBlocked > 0
      ? `${facts.snippetBlocked} pages block snippets`
      : null;
  }
  if (id === "GEO10" && typeof facts.longPages === "number") {
    return `${facts.longWithoutHeadings} of ${facts.longPages} long pages have no subheadings`;
  }
  if (id === "GEO6" && typeof facts.hosts === "number") {
    return `${facts.hosts} different profile sites linked`;
  }
  return null;
}

function CheckRow({
  check,
  projectId,
}: {
  check: GeoCheckView;
  projectId: string;
}) {
  const attention = check.status === "WARN" || check.status === "INFO";
  const line = factsLine(check);
  return (
    <li className="space-y-1 py-3" data-check={check.id}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={check.status} />
        <span className="text-sm font-medium">{check.title}</span>
      </div>
      {check.status === "ACK" ? (
        <p className="text-xs text-muted-foreground">
          You decided this. It is not counted in your score.
        </p>
      ) : null}
      {line ? <p className="text-xs text-muted-foreground">{line}</p> : null}
      {attention ? (
        <p className="text-xs">{check.recommendation ?? check.how}</p>
      ) : null}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground select-none">
          Why it matters
        </summary>
        <p className="mt-1 text-muted-foreground">{check.why}</p>
      </details>
      {check.canAcknowledge && check.id === "GEO9" ? (
        <AckForm
          projectId={projectId}
          checkId={check.id}
          on={check.status !== "ACK"}
        />
      ) : null}
    </li>
  );
}

function CrawlersCard({
  panel,
  projectId,
}: {
  panel: GeoPanel;
  projectId: string;
}) {
  if (panel.crawlers.length === 0) return null;
  const search = panel.checks.find((check) => check.id === "GEO2");
  return (
    <div className={cn(CARD, "space-y-2")} data-card="ai-crawlers">
      <p className="text-sm font-medium">Your decision: AI crawlers</p>
      <p className="text-xs text-muted-foreground">
        Your robots.txt decides which AI crawlers may read your pages. Blocking
        the ones that answer questions keeps your pages out of those answers.
        Agentelse only reports this and never edits your robots.txt.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-xs" data-table="ai-crawlers">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">AI crawler</th>
              <th className="py-1 pr-3 font-medium">Company</th>
              <th className="py-1 pr-3 font-medium">Used for</th>
              <th className="py-1 font-medium">Access</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-foreground/10">
            {panel.crawlers.map((crawler) => (
              <tr key={crawler.token}>
                <td className="py-1 pr-3">{crawler.token}</td>
                <td className="py-1 pr-3">{crawler.owner}</td>
                <td className="py-1 pr-3">
                  {crawler.purpose === "search"
                    ? "Answers and search"
                    : "AI training"}
                </td>
                <td className="py-1">
                  {crawler.allowed ? "Allowed" : "Blocked"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{GEO_TRAINING_NOTE}</p>
      {search?.canAcknowledge ? (
        <div className="space-y-1">
          {search.status === "ACK" ? (
            <p className="text-xs text-muted-foreground">
              You decided this. It is not counted in your score.
            </p>
          ) : null}
          <AckForm
            projectId={projectId}
            checkId="GEO2"
            on={search.status !== "ACK"}
          />
        </div>
      ) : null}
    </div>
  );
}

function LlmsCard({ panel }: { panel: GeoPanel }) {
  const { llms } = panel;
  return (
    <div className={cn(CARD, "space-y-2")} data-card="llms">
      <p className="text-sm font-medium">llms.txt</p>
      {llms.state === "present" ? (
        <p className="text-xs text-muted-foreground">
          Your site has an llms.txt file.
        </p>
      ) : llms.state === "invalid" ? (
        <p className="text-xs text-muted-foreground">
          Your llms.txt file does not look right. It should start with a title
          line such as &ldquo;# Your name&rdquo; and list your key pages.
        </p>
      ) : llms.state === "missing" ? (
        <p className="text-xs text-muted-foreground">
          Your site has no llms.txt file. It is optional and still an emerging
          convention.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Agentelse could not check for an llms.txt file this time.
        </p>
      )}
      {llms.state === "missing" && llms.draft ? (
        <>
          <p className="text-xs">{GEO_LLMS_INSTRUCTION}</p>
          <LlmsDraft text={llms.draft} />
        </>
      ) : null}
    </div>
  );
}

function CheckAgain({
  panel,
  projectId,
}: {
  panel: GeoPanel;
  projectId: string;
}) {
  if (!panel.canAuditNow) {
    return (
      <p className="text-xs text-muted-foreground">
        The check runs every week. You can run it again 6 hours after the last
        one.
      </p>
    );
  }
  return (
    <ActionForm
      action={auditGeoNowAction}
      successMessage="The check is done"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <SubmitButton variant="outline" size="xs">
        Check again
      </SubmitButton>
    </ActionForm>
  );
}

export function GeoPanelView({
  panel,
  projectId,
}: {
  panel: GeoPanel;
  projectId: string;
}) {
  if (panel.state !== "ready") {
    return (
      <div className="space-y-4">
        <Header panel={panel} />
        <div className={CARD} data-card="waiting">
          <p className="text-xs text-muted-foreground">
            {panel.state === "waiting"
              ? "Your first check is waiting for the site audit. It starts by itself and takes a few minutes."
              : "Verify your site and run the site audit above first. The AI visibility check starts after that."}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Header panel={panel} />
      <div className={CARD} data-card="checks">
        <ul className="divide-y divide-foreground/10">
          {panel.checks.map((check) => (
            <CheckRow key={check.id} check={check} projectId={projectId} />
          ))}
        </ul>
      </div>
      <CrawlersCard panel={panel} projectId={projectId} />
      <LlmsCard panel={panel} />
      {panel.traffic ? <AiTrafficCard traffic={panel.traffic} /> : null}
      <CheckAgain panel={panel} projectId={projectId} />
    </div>
  );
}
