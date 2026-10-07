"use client";

import { useState, useSyncExternalStore } from "react";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { DatePicker } from "@/components/ui/date-time-picker";
import {
  SPLIT_INSTRUCTIONS,
  SPLIT_KIND_LABEL,
  SPLIT_STATUS_LABEL,
  splitDetail,
  splitHeadline,
} from "@/lib/seo/agency/split/copy";
import {
  OPEN_SPLIT_STATUSES,
  type SplitStatus,
  type SplitTestView,
  type SplitVerification,
} from "@/lib/seo/agency/split/types";
import {
  applySplitTestViaCmsAction,
  cancelSplitTestAction,
  checkSplitTestNowAction,
  markSplitTestAppliedAction,
} from "@/server/actions/gsc-split-test-actions";

import { HINT_CLASS, formatDay } from "./form-helpers";

// Bölünmüş testlerin listesi (SC-F9): her test için durum, kollar, bir sonraki
// adımın doğru düğmesi ve sonuç. Sonuç metinleri sabit şablonlardan gelir
// (splitHeadline/splitDetail); sayılar yalnız kayıtlı değerlendirmeden alınır.

export const SECONDARY_SPLIT_NOTE =
  "Changes on secondary sites are confirmed by you, not checked automatically.";
export const CMS_APPROVAL_NOTE = "Each page needs its own approval.";

const VERIFY_REASON_TEXT: Record<
  NonNullable<SplitVerification["reason"]>,
  string
> = {
  NOT_SEEN: "The change isn't visible on the test pages yet.",
  FETCH_FAILED: "Some sample pages couldn't be loaded. We'll try again.",
  NO_SITE: "No crawlable site is connected, so you need to confirm the change.",
  CMS_CHANGE_FAILED: "Some approved changes failed or were rejected.",
  CONTROL_CHANGED:
    "The control pages changed too, so the test can't be trusted.",
};

const STATUS_VARIANT: Record<
  SplitStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  DRAFT: "outline",
  APPLIED: "secondary",
  EVALUATING: "secondary",
  WORKED: "default",
  DIDNT: "destructive",
  INCONCLUSIVE: "outline",
  CANCELLED: "outline",
  EXPIRED: "outline",
};

function lines(value: string | readonly string[]): string[] {
  return ([] as string[]).concat(value as string | string[]);
}

// Tarayıcının bugünü: sunucu çiziminde boş, hidrasyondan sonra gerçek değer.
// useSyncExternalStore sunucu/istemci farkını uyuşmazlık yaratmadan karşılar.
const noopSubscribe = () => () => {};

function clientToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function daysBefore(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function AppliedOnForm({
  projectId,
  testId,
}: {
  projectId: string;
  testId: string;
}) {
  const today = useSyncExternalStore(noopSubscribe, clientToday, () => "");
  const [picked, setPicked] = useState("");
  const day = picked || today;
  return (
    <ActionForm
      action={markSplitTestAppliedAction}
      successMessage="Marked as applied"
      className="flex flex-wrap items-end gap-2"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="testId" value={testId} />
      <label className="space-y-1 text-xs text-muted-foreground">
        <span className="block">Applied on</span>
        <div className="w-44">
          <DatePicker
            name="appliedOn"
            aria-label="Date you applied the change"
            value={day}
            onChange={setPicked}
            min={today ? daysBefore(today, 60) : undefined}
            max={today || undefined}
          />
        </div>
      </label>
      <SubmitButton size="sm" variant="outline" disabled={day === ""}>
        I applied it
      </SubmitButton>
    </ActionForm>
  );
}

function TestForm({
  projectId,
  testId,
  action,
  label,
  success,
  variant = "outline",
}: {
  projectId: string;
  testId: string;
  action: (
    formData: FormData,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  label: string;
  success: string;
  variant?: "outline" | "ghost" | "default";
}) {
  return (
    <ActionForm action={action} successMessage={success}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="testId" value={testId} />
      <SubmitButton size="sm" variant={variant}>
        {label}
      </SubmitButton>
    </ActionForm>
  );
}

export function SplitTestRow({
  projectId,
  test,
  applyReady,
}: {
  projectId: string;
  test: SplitTestView;
  applyReady: boolean;
}) {
  const open = OPEN_SPLIT_STATUSES.includes(test.status);
  const evaluation = test.evaluation;
  const showCms = test.status === "DRAFT" && test.canApplyViaCms && applyReady;
  return (
    <li
      data-test={test.id}
      data-status={test.status}
      className="space-y-3 rounded-xl p-3 ring-1 ring-foreground/10"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{test.name}</p>
          <p className={HINT_CLASS}>
            {SPLIT_KIND_LABEL[test.changeKind]} · created{" "}
            {formatDay(test.createdAt)}
          </p>
        </div>
        <Badge variant={STATUS_VARIANT[test.status]}>
          {SPLIT_STATUS_LABEL[test.status]}
        </Badge>
      </div>

      {test.description ? (
        <p className="text-sm text-muted-foreground">{test.description}</p>
      ) : null}

      <div className="space-y-0.5 text-sm">
        <p className="tabular-nums">
          {test.arms.test} test pages and {test.arms.control} control pages
        </p>
        {test.perGroup.length > 0 ? (
          <ul className={`${HINT_CLASS} space-y-0.5`}>
            {test.perGroup.map((group) => (
              <li key={group.group} className="tabular-nums">
                {group.group}: {group.test} test, {group.control} control
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {test.isSecondarySite ? (
        <p className={HINT_CLASS} data-note="secondary">
          {SECONDARY_SPLIT_NOTE}
        </p>
      ) : null}

      {test.status === "DRAFT" ? (
        <div className="space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {lines(SPLIT_INSTRUCTIONS[test.changeKind]).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="flex flex-wrap items-end gap-3">
            <AppliedOnForm projectId={projectId} testId={test.id} />
            {showCms ? (
              <div className="space-y-1">
                <TestForm
                  projectId={projectId}
                  testId={test.id}
                  action={applySplitTestViaCmsAction}
                  label="Apply with approval"
                  success="Changes proposed for approval"
                />
                <p className={HINT_CLASS}>{CMS_APPROVAL_NOTE}</p>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {test.status === "APPLIED" ? (
        <div className="space-y-2" data-step="applied">
          <p className="text-sm">
            Waiting for the change to be confirmed
            {test.appliedVia === "CMS" ? " through your site's approvals" : ""}.
          </p>
          {test.cms ? (
            <p className={`${HINT_CLASS} tabular-nums`}>
              {test.cms.verified} of {test.cms.total} pages confirmed
              {test.cms.waiting > 0 ? `, ${test.cms.waiting} waiting` : ""}
              {test.cms.failed > 0 ? `, ${test.cms.failed} failed` : ""}.
            </p>
          ) : null}
          {test.verification && test.verification.checks.length > 0 ? (
            <ul role="list" aria-label="Checks" className="space-y-0.5 text-xs">
              {test.verification.checks.map((check) => (
                <li key={check.key}>
                  <span className="font-medium">
                    {check.ok ? "Passed" : "Not yet"}
                  </span>{" "}
                  {check.label}
                </li>
              ))}
            </ul>
          ) : null}
          {test.verification?.reason ? (
            <p className={HINT_CLASS}>
              {VERIFY_REASON_TEXT[test.verification.reason]}
            </p>
          ) : null}
          {test.crawlerVerifiable ? (
            <TestForm
              projectId={projectId}
              testId={test.id}
              action={checkSplitTestNowAction}
              label="Check now"
              success="Check queued"
            />
          ) : null}
        </div>
      ) : null}

      {test.status === "EVALUATING" ? (
        <p className="text-sm" data-step="evaluating">
          {test.evaluateAfter
            ? `Measuring until ${formatDay(test.evaluateAfter)}`
            : "Measuring"}
          {test.measureFrom ? (
            <span className={`${HINT_CLASS} block`}>
              Counting from {formatDay(test.measureFrom)} ({test.windowDays}{" "}
              days).
            </span>
          ) : null}
        </p>
      ) : null}

      {evaluation &&
      (test.status === "WORKED" ||
        test.status === "DIDNT" ||
        test.status === "INCONCLUSIVE") ? (
        <div className="space-y-1" data-step="result">
          <p className="text-sm font-medium">{splitHeadline(evaluation)}</p>
          {lines(splitDetail(evaluation)).map((line) => (
            <p key={line} className={HINT_CLASS}>
              {line}
            </p>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="flex justify-end">
          <TestForm
            projectId={projectId}
            testId={test.id}
            action={cancelSplitTestAction}
            label="Cancel test"
            success="Test cancelled"
            variant="ghost"
          />
        </div>
      ) : null}
    </li>
  );
}

export function SplitTestList({
  projectId,
  tests,
  applyReady,
}: {
  projectId: string;
  tests: SplitTestView[];
  applyReady: boolean;
}) {
  if (tests.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No split tests yet. Create one to find out whether a change works before
        rolling it out to every page.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {tests.map((test) => (
        <SplitTestRow
          key={test.id}
          projectId={projectId}
          test={test}
          applyReady={applyReady}
        />
      ))}
    </ul>
  );
}
