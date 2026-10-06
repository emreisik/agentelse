"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  copyToClipboard,
  downloadText,
  printHtml,
} from "@/components/module-flows/analytics/share";
import {
  buildSeoReportMarkdown,
  buildSeoReportPrintHtml,
  seoReportFileName,
} from "@/lib/seo/reports/export";
import type { SeoReportView } from "@/lib/seo/reports/types";

// Raporun dışa aktarma düğmeleri (SC-F5): Markdown kopyala, .md indir, "Print /
// PDF". Metinler görünümdeki saklı anlık görüntüden üretilir, hiçbir şey
// çekilmez. Kısa süreli geri bildirim düğmelerin yanında görünür.

const FEEDBACK_MS = 2000;

export function ReportExportButtons({
  view,
  brand,
}: {
  view: SeoReportView;
  brand?: string;
}) {
  const [feedback, setFeedback] = useState<string | null>(null);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const options = brand ? { brand } : undefined;

  const copy = async () => {
    const ok = await copyToClipboard(buildSeoReportMarkdown(view, options));
    setFeedback(ok ? "Copied" : "Could not copy");
  };
  const download = () => {
    const ok = downloadText(
      seoReportFileName(view, "md"),
      buildSeoReportMarkdown(view, options),
      "text/markdown",
    );
    setFeedback(ok ? "Downloaded" : "Could not download");
  };
  const print = () => {
    if (!printHtml(buildSeoReportPrintHtml(view, options))) {
      setFeedback("Could not print");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => void copy()}
      >
        Copy Markdown
      </Button>
      <Button type="button" variant="ghost" size="xs" onClick={download}>
        Download .md
      </Button>
      <Button type="button" variant="ghost" size="xs" onClick={print}>
        Print / PDF
      </Button>
      <span
        role="status"
        aria-live="polite"
        className="text-xs text-muted-foreground"
      >
        {feedback}
      </span>
    </div>
  );
}
