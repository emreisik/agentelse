"use client";

import { Copy, Download, Printer } from "lucide-react";
import { toast } from "sonner";

import { ANALYTICS_COPY as COPY } from "@/lib/module-flows/analytics/copy";
import {
  buildReportMarkdown,
  buildReportPlainText,
  buildReportPrintHtml,
  reportFileName,
  type ExportOptions,
} from "@/lib/module-flows/analytics/export";
import type { ReportData } from "@/lib/module-flows/analytics/report";

import { GroupHeading, PrimaryButton, QuietButton, StepActions } from "./parts";
import { copyToClipboard, downloadText, printHtml } from "./share";

// Step 5, Share: the report leaves the card as a copied summary (plain text), a
// Markdown file or a printed page ("Save as PDF"). All three are built in the
// browser from the stored report, so they work in a completed Work too. The
// first one that works marks the flow delivered (onShared).

export function DeliverStep({
  report,
  options,
  onShared,
  announce,
}: {
  report: ReportData;
  options: ExportOptions;
  onShared: () => void;
  announce: (message: string) => void;
}) {
  const done = (message: string) => {
    toast.success(message);
    announce(message);
    onShared();
  };
  const fail = (message: string) => {
    toast.error(message);
    announce(message);
  };

  return (
    <div className="space-y-2">
      <GroupHeading>{COPY.shareHeading}</GroupHeading>
      <StepActions
        quiet={
          <>
            <QuietButton
              label={COPY.copy}
              icon={<Copy aria-hidden="true" />}
              onClick={() => {
                void copyToClipboard(
                  buildReportPlainText(report, options),
                ).then((ok) =>
                  ok ? done(COPY.copied) : fail(COPY.copyFailed),
                );
              }}
            />
            <QuietButton
              label={COPY.download}
              icon={<Download aria-hidden="true" />}
              onClick={() => {
                const ok = downloadText(
                  reportFileName(report),
                  buildReportMarkdown(report, options),
                  "text/markdown;charset=utf-8",
                );
                if (ok) done(COPY.downloaded);
                else fail(COPY.downloadFailed);
              }}
            />
          </>
        }
        primary={
          <PrimaryButton
            label={COPY.print}
            icon={<Printer aria-hidden="true" />}
            onClick={() => {
              if (printHtml(buildReportPrintHtml(report, options))) {
                done(COPY.printOpened);
              } else {
                fail(COPY.printFailed);
              }
            }}
          />
        }
      />
    </div>
  );
}
