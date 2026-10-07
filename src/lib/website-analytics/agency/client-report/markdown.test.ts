import { describe, expect, it } from "vitest";

import type { ClientDoc } from "./document";
import { buildClientDocMarkdown, clientDocFileName } from "./markdown";

// Bu dosyanın kanıtladığı: başlık, KPI listesi, GFM tablo ve madde işareti;
// "|" ve "<" kaçırılır, satır sonları tek boşluğa iner; "Prepared by" satırı ve
// marka alt bilgisi sonda; dosya adı yalnız ASCII ve slug.

function doc(patch: Partial<ClientDoc> = {}): ClientDoc {
  return {
    title: "Weekly website report · Sep 28 – Oct 4",
    subtitle: "Example Shop",
    periodLabel: "Sep 28 – Oct 4",
    clientName: "Shop Ltd",
    builtAt: "2026-10-05T07:30:00.000Z",
    isDemo: false,
    blocks: [
      { type: "heading", text: "Key numbers", level: 2 },
      {
        type: "kpis",
        items: [
          { label: "Sessions", value: "4,760", delta: "+10.7% vs previous period", tone: "up" },
          { label: "Users", value: "—", delta: null, tone: null },
        ],
      },
      {
        type: "table",
        title: "Channels",
        columns: ["Channel", "Sessions"],
        rows: [["A | B", "10"], ["<script>x</script>", "2"]],
        note: "Rows\nare capped.",
      },
      { type: "paragraph", text: "line one\r\n  line two <b>", muted: true },
      { type: "bullets", items: ["a\nb", "<i>c"] },
    ],
    footnotes: ["Snapshot note."],
    ...patch,
  };
}

const branding = { displayName: "Acme Digital", footer: "Numbers from Google Analytics." };

describe("buildClientDocMarkdown", () => {
  const md = buildClientDocMarkdown(doc(), branding);

  it("writes headings, the KPI list, a GFM table and bullets", () => {
    expect(md.startsWith("# Weekly website report · Sep 28 – Oct 4\n")).toBe(true);
    expect(md).toContain("Example Shop · Sep 28 – Oct 4");
    expect(md).toContain("## Key numbers");
    expect(md).toContain("- **Sessions**: 4,760 (+10.7% vs previous period)");
    expect(md).toContain("- **Users**: —");
    expect(md).toContain("### Channels");
    expect(md).toContain("| Channel | Sessions |");
    expect(md).toContain("| --- | ---: |");
    expect(md).toContain("- a b");
  });

  it("escapes pipes and angle brackets and collapses newlines", () => {
    expect(md).toContain("| A \\| B | 10 |");
    expect(md).toContain("| \\<script>x\\</script> | 2 |");
    expect(md).toContain("*line one line two \\<b>*");
    expect(md).toContain("- \\<i>c");
    expect(md).toContain("*Rows are capped.*");
    expect(md).not.toMatch(/line one\r?\n/);
  });

  it("ends with the footnotes, 'Prepared by' and the branding footer", () => {
    const tail = md.trimEnd().split("\n").slice(-5);
    expect(tail).toEqual([
      "---",
      "",
      "Snapshot note.",
      "",
      "Prepared by Acme Digital",
      "",
      "Numbers from Google Analytics.",
    ].slice(-5));
    expect(md.indexOf("Prepared by Acme Digital")).toBeLessThan(
      md.indexOf("Numbers from Google Analytics."),
    );
    expect(md.endsWith("Numbers from Google Analytics.\n")).toBe(true);
  });

  it("skips an empty footer and marks demo data", () => {
    const out = buildClientDocMarkdown(doc({ isDemo: true }), {
      displayName: "Acme Digital",
      footer: null,
    });
    expect(out.endsWith("Prepared by Acme Digital\n")).toBe(true);
    expect(out).toContain("Example Shop · Sep 28 – Oct 4 · Demo data");
  });
});

describe("clientDocFileName", () => {
  it("slugs the title to ASCII", () => {
    expect(clientDocFileName(doc(), "md")).toBe(
      "weekly-website-report-sep-28-oct-4.md",
    );
  });

  it("strips non-ASCII and falls back when nothing is left", () => {
    expect(clientDocFileName(doc({ title: "Rapor · Şubat ✓" }), "md")).toBe(
      "rapor-subat.md",
    );
    expect(clientDocFileName(doc({ title: "日本語" }), "md")).toBe(
      "website-report.md",
    );
    const name = clientDocFileName(doc({ title: "x".repeat(300) }), "md");
    expect(name).toMatch(/^[a-z0-9-]+\.md$/);
    expect(name.length).toBeLessThan(90);
  });
});
