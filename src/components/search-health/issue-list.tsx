import { ExternalLink } from "lucide-react";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { cn } from "@/lib/utils";
import { muteSearchAlertAction } from "@/server/actions/search-health-actions";
import type { SearchHealthPanel } from "@/server/seo/health/panel";

// Açık arama sağlığı uyarıları (SC-F3): önem çipi, başlık, ayrıntı, "How to
// fix" rehberi (?issue= ile gelinen uyarıda açık) ve 7 gün susturma.

type Issue = SearchHealthPanel["issues"][number];

const SEVERITY_LABEL: Record<Issue["severity"], string> = {
  CRITICAL: "Critical",
  WARN: "Warning",
  INFO: "Info",
};

const SEVERITY_CLASS: Record<Issue["severity"], string> = {
  CRITICAL: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  WARN: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  INFO: "bg-muted text-muted-foreground",
};

export function SeverityChip({ severity }: { severity: Issue["severity"] }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        SEVERITY_CLASS[severity],
      )}
    >
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

function Guide({ issue }: { issue: Issue }) {
  const { guide } = issue;
  return (
    <details className="text-xs" open={issue.open}>
      <summary className="cursor-pointer font-medium text-foreground select-none">
        How to fix
      </summary>
      <div className="mt-2 space-y-2 text-muted-foreground">
        <ol className="list-decimal space-y-1 pl-4">
          {guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {guide.screen ? <p>In Search Console: {guide.screen}</p> : null}
        {guide.learnMoreUrl ? (
          <a
            href={guide.learnMoreUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
          >
            Learn more
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </details>
  );
}

export function IssueList({
  projectId,
  issues,
  canMute,
}: {
  projectId: string;
  issues: Issue[];
  canMute: boolean;
}) {
  if (issues.length === 0) {
    return <p className="text-sm">No search health issues right now.</p>;
  }
  return (
    <ul className="divide-y divide-foreground/10">
      {issues.map((issue) => (
        <li
          key={issue.id}
          id={`issue-${issue.id}`}
          data-kind={issue.kind}
          className="scroll-mt-20 space-y-2 py-3 first:pt-0 last:pb-0"
        >
          <div className="flex items-start gap-2">
            <SeverityChip severity={issue.severity} />
            <p className="text-sm font-medium">{issue.title}</p>
          </div>
          {issue.detail ? (
            <p className="text-xs text-muted-foreground">{issue.detail}</p>
          ) : null}
          <Guide issue={issue} />
          {canMute ? (
            <ActionForm
              action={muteSearchAlertAction}
              successMessage="Muted for 7 days"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="alertId" value={issue.id} />
              <SubmitButton variant="ghost" size="xs">
                Mute for 7 days
              </SubmitButton>
            </ActionForm>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
