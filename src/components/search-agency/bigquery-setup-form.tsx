"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Minus, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import {
  BQ_REMOVE_NOTE,
  BQ_SOURCE_ERROR_TEXT,
  type BqVerifyResult,
  type BqVerifyStep,
} from "@/lib/seo/agency/bq/copy";
import {
  MAX_BYTES_CHOICES_GB,
  MONTHLY_CHOICES_GB,
} from "@/lib/seo/agency/bq/limits";
import type { BqBadge } from "@/lib/seo/agency/types";
import {
  saveBigQuerySourceAction,
  setBigQueryStateAction,
  verifyBigQuerySourceAction,
} from "@/server/actions/gsc-bigquery-actions";

import {
  HINT_CLASS,
  INPUT_CLASS,
  SELECT_CLASS,
  bytesChoiceLabel,
} from "./form-helpers";

// BigQuery kartının istemci parçaları (SC-F9): kurulum formu, doğrulama
// adımları ve aç/duraklat/kaldır düğmeleri. Ham Google ya da BigQuery iletisi
// hiçbir zaman çizilmez; yalnız sabit metinler (BQ_SOURCE_ERROR_TEXT).

export function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => toast.error("Couldn't copy. Select the text instead."));
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : label}
    </Button>
  );
}

export type BigQueryFormDefaults = {
  bqProjectId: string;
  dataset: string;
  maxGb: number;
  monthlyGb: number;
  importAll: boolean;
};

export function BigQuerySetupForm({
  projectId,
  linkId,
  defaults,
  submitLabel,
}: {
  projectId: string;
  linkId: string;
  defaults: BigQueryFormDefaults;
  submitLabel: string;
}) {
  return (
    <ActionForm
      action={saveBigQuerySourceAction}
      successMessage="BigQuery settings saved"
      className="space-y-3"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="linkId" value={linkId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">Google Cloud project ID</span>
          <input
            name="bqProjectId"
            required
            defaultValue={defaults.bqProjectId}
            autoComplete="off"
            spellCheck={false}
            placeholder="my-project-123"
            className={`${INPUT_CLASS} w-full`}
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">Dataset</span>
          <input
            name="dataset"
            required
            defaultValue={defaults.dataset}
            autoComplete="off"
            spellCheck={false}
            className={`${INPUT_CLASS} w-full`}
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">Largest single import</span>
          <select
            name="maxGb"
            defaultValue={String(defaults.maxGb)}
            className={`${SELECT_CLASS} w-full`}
          >
            {MAX_BYTES_CHOICES_GB.map((gb) => (
              <option key={gb} value={gb}>
                {bytesChoiceLabel(gb)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">Monthly budget</span>
          <select
            name="monthlyGb"
            defaultValue={String(defaults.monthlyGb)}
            className={`${SELECT_CLASS} w-full`}
          >
            {MONTHLY_CHOICES_GB.map((gb) => (
              <option key={gb} value={gb}>
                {bytesChoiceLabel(gb)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="importAll"
          defaultChecked={defaults.importAll}
          className="mt-0.5 size-4"
        />
        <span>
          Also replace complete weeks
          <span className={`${HINT_CLASS} block`}>
            By default only weeks the API truncated or never returned are
            imported.
          </span>
        </span>
      </label>
      <p className={HINT_CLASS}>
        Queries run in your Google Cloud project and are billed to it. These
        limits stop an import before it can exceed them.
      </p>
      <SubmitButton size="sm">{submitLabel}</SubmitButton>
    </ActionForm>
  );
}

const STEP_STATE_TEXT: Record<BqVerifyStep["state"], string> = {
  ok: "OK",
  warn: "Check",
  fail: "Failed",
  skipped: "Skipped",
};

function StepIcon({ state }: { state: BqVerifyStep["state"] }) {
  if (state === "ok") return <Check className="size-4 text-emerald-600" />;
  if (state === "warn") {
    return <TriangleAlert className="size-4 text-amber-600" />;
  }
  if (state === "fail") return <X className="size-4 text-destructive" />;
  return <Minus className="size-4 text-muted-foreground" />;
}

// Durum metni her satırda yazılıdır: anlam yalnız renk ya da simgeyle taşınmaz.
export function VerifySteps({ result }: { result: BqVerifyResult }) {
  return (
    <div className="space-y-2" data-state={result.ok ? "verified" : "failed"}>
      <ul role="list" aria-label="Verification steps" className="space-y-1.5">
        {result.steps.map((step) => (
          <li key={step.key} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 shrink-0">
              <StepIcon state={step.state} />
            </span>
            <span className="min-w-0">
              <span className="font-medium">{step.label}</span>{" "}
              <span className="text-xs text-muted-foreground">
                {STEP_STATE_TEXT[step.state]}
              </span>
              {step.detail ? (
                <span className={`${HINT_CLASS} block`}>{step.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {!result.ok && result.errorCode ? (
        <p className="text-sm text-destructive">
          {BQ_SOURCE_ERROR_TEXT[result.errorCode]}
        </p>
      ) : null}
    </div>
  );
}

export function BigQueryControls({
  projectId,
  linkId,
  status,
}: {
  projectId: string;
  linkId: string;
  status: BqBadge;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<BqVerifyResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const canTurnOn =
    status === "VERIFIED" ||
    status === "PAUSED" ||
    status === "BUDGET" ||
    (result?.ok === true && status !== "ACTIVE");

  function verify() {
    const data = new FormData();
    data.set("projectId", projectId);
    data.set("linkId", linkId);
    startTransition(async () => {
      try {
        const response = await verifyBigQuerySourceAction(data);
        setResult(response.result);
        setFailure(
          response.result ? null : (response.message ?? "Couldn't verify."),
        );
        router.refresh();
      } catch {
        setResult(null);
        setFailure("Couldn't verify. Try again in a moment.");
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={verify}
        >
          {pending ? "Verifying..." : "Verify"}
        </Button>
        {canTurnOn ? (
          <ActionForm
            action={setBigQueryStateAction}
            successMessage="BigQuery import is on"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="linkId" value={linkId} />
            <input type="hidden" name="state" value="ON" />
            <SubmitButton size="sm">Turn on</SubmitButton>
          </ActionForm>
        ) : null}
        {status === "ACTIVE" ? (
          <ActionForm
            action={setBigQueryStateAction}
            successMessage="BigQuery import paused"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="linkId" value={linkId} />
            <input type="hidden" name="state" value="PAUSE" />
            <SubmitButton size="sm" variant="outline">
              Pause
            </SubmitButton>
          </ActionForm>
        ) : null}
        <details className="relative">
          <summary className="inline-flex h-7 cursor-pointer list-none items-center rounded-lg px-2.5 text-[0.8rem] font-medium hover:bg-muted [&::-webkit-details-marker]:hidden">
            Remove
          </summary>
          <div className="absolute left-0 z-10 mt-1 w-72 space-y-2 rounded-xl bg-popover p-3 text-xs shadow-md ring-1 ring-foreground/10">
            <p className="text-muted-foreground">
              Remove the BigQuery connection for this site? {BQ_REMOVE_NOTE}
            </p>
            <ActionForm
              action={setBigQueryStateAction}
              successMessage="BigQuery connection removed"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="linkId" value={linkId} />
              <input type="hidden" name="state" value="REMOVE" />
              <SubmitButton size="xs" variant="destructive">
                Remove connection
              </SubmitButton>
            </ActionForm>
          </div>
        </details>
      </div>
      {result ? <VerifySteps result={result} /> : null}
      {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
    </div>
  );
}
