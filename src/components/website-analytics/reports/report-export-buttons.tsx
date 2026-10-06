"use client";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  copyToClipboard,
  downloadText,
  printHtml,
} from "@/components/module-flows/analytics/share";
import {
  isExportableReport,
  websiteReportFileName,
  websiteReportMarkdown,
  websiteReportPrintHtml,
} from "@/lib/website-analytics/reports/export";
import { websiteReportPlainText } from "@/lib/website-analytics/reports/text";
import type { WebsiteReportCardData } from "@/lib/website-analytics/reports/types";

// Rapor kartının dışa aktarma düğmeleri: Copy her kartta; Markdown ve
// "Print / PDF" yalnız haftalık, aylık ve plan kartlarında. Metinler kartın
// saklı kopyasından üretilir, hiçbir şey çekilmez.

export function ReportExportButtons({
  card,
  brand,
}: {
  card: WebsiteReportCardData;
  brand?: string | null;
}) {
  const exportable = isExportableReport(card);
  const options = { brand: brand ?? null };

  const copy = async () => {
    const ok = await copyToClipboard(websiteReportPlainText(card));
    if (ok) toast.success("Copied");
    else toast.error("Could not copy");
  };
  const markdown = () => {
    const ok = downloadText(
      websiteReportFileName(card, "md"),
      websiteReportMarkdown(card, options),
      "text/markdown",
    );
    if (ok) toast.success("Downloaded");
    else toast.error("Could not download");
  };
  const print = () => {
    if (!printHtml(websiteReportPrintHtml(card, options))) {
      toast.error("Could not print");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button type="button" variant="ghost" size="xs" onClick={() => void copy()}>
        Copy
      </Button>
      {exportable ? (
        <>
          <Button type="button" variant="ghost" size="xs" onClick={markdown}>
            Markdown
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={print}>
            Print / PDF
          </Button>
        </>
      ) : null}
    </div>
  );
}
