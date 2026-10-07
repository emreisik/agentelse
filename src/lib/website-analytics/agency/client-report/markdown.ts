import type { ClientDoc } from "./document";
import { lab, resolveClientReportLabels } from "./labels";

// Müşteri belgesinin Markdown'ı ve dosya adı (GA-F8). Kaçırma kuralları
// reports/export.ts ile aynı: satır sonları tek boşluğa iner, "<" kaçırılır
// (Google'dan gelen metin görüntüleyicide ham HTML olmasın), tablo hücresinde
// "|" kaçırılır. Saf ve izomorfik.

function mdText(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").replace(/</g, "\\<");
}

function mdCell(text: string): string {
  return mdText(text).replace(/\|/g, "\\|");
}

export function buildClientDocMarkdown(
  doc: ClientDoc,
  branding: { displayName: string; footer: string | null },
  language?: string | null,
): string {
  const labels = resolveClientReportLabels(language);
  const meta = [doc.subtitle, doc.periodLabel]
    .filter((part): part is string => !!part)
    .join(" · ");
  const lines: string[] = [`# ${mdText(doc.title)}`];
  const metaLine = doc.isDemo
    ? [meta, lab(labels, "meta.demo")].filter(Boolean).join(" · ")
    : meta;
  if (metaLine) lines.push("", mdText(metaLine));

  for (const block of doc.blocks) {
    lines.push("");
    switch (block.type) {
      case "heading":
        lines.push(`${block.level === 2 ? "##" : "###"} ${mdText(block.text)}`);
        break;
      case "paragraph": {
        const text = mdText(block.text);
        lines.push(block.muted && !text.includes("*") ? `*${text}*` : text);
        break;
      }
      case "bullets":
        lines.push(...block.items.map((item) => `- ${mdText(item)}`));
        break;
      case "kpis":
        lines.push(
          ...block.items.map(
            (item) =>
              `- **${mdText(item.label)}**: ${mdText(item.value)}${
                item.delta ? ` (${mdText(item.delta)})` : ""
              }`,
          ),
        );
        break;
      case "table":
        if (block.title) lines.push(`### ${mdText(block.title)}`, "");
        lines.push(
          `| ${block.columns.map(mdCell).join(" | ")} |`,
          `| ${block.columns.map((_, index) => (index === 0 ? "---" : "---:")).join(" | ")} |`,
          ...block.rows.map((row) => `| ${row.map(mdCell).join(" | ")} |`),
        );
        if (block.note) lines.push("", `*${mdText(block.note)}*`);
        break;
    }
  }

  lines.push("", "---", "");
  for (const note of doc.footnotes) lines.push(mdText(note), "");
  const displayName = branding.displayName.replace(/\s+/g, " ").trim();
  if (displayName) {
    lines.push(`${lab(labels, "md.preparedBy")} ${mdText(displayName)}`, "");
  }
  const footer = branding.footer?.trim();
  if (footer) lines.push(mdText(footer), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

// Yalnız ASCII: başlıktan küçük harf, rakam ve tire kalır.
export function clientDocFileName(doc: ClientDoc, extension: "md"): string {
  const slug = doc.title
    .normalize("NFKD")
    .replace(/[^ -~]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return `${slug || "website-report"}.${extension}`;
}
