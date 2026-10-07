import { SEO_CHANGE_KINDS, type SeoChangeKind } from "./types";

// SC-F8: onay kartında gösterilen ayrıntı satırları ve Task yükü işareti.
// Saf dosya. Yük `seoApply` işaretiyle genel WEBSITE_UPDATE görevlerinden
// ayrılır; `details` savunmacı okunur (en çok 12 satır, değer 240 karakter).

export type SeoApplyPayload = {
  seoApply: { v: 1; changeId: string; kind: SeoChangeKind };
  details?: { label: string; value: string }[];
};

type Row = { label: string; value: string };

const MAX_ROWS = 12;
const MAX_VALUE = 240;
const MAX_LABEL = 60;

function clip(value: string, max: number): string {
  const chars = Array.from(value.trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("");
}

function cleanRows(rows: readonly Row[]): Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    if (out.length >= MAX_ROWS) break;
    const label = clip(row.label, MAX_LABEL);
    const value = clip(row.value, MAX_VALUE);
    if (label && value) out.push({ label, value });
  }
  return out;
}

export function buildSeoApplyPayload(input: {
  changeId: string;
  kind: SeoChangeKind;
  details: { label: string; value: string }[];
}): SeoApplyPayload {
  return {
    seoApply: { v: 1, changeId: input.changeId, kind: input.kind },
    details: cleanRows(input.details),
  };
}

export function isSeoApplyPayload(payload: unknown): payload is SeoApplyPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const mark = (payload as { seoApply?: unknown }).seoApply;
  if (typeof mark !== "object" || mark === null) return false;
  const { v, changeId, kind } = mark as {
    v?: unknown;
    changeId?: unknown;
    kind?: unknown;
  };
  return (
    v === 1 &&
    typeof changeId === "string" &&
    changeId.length > 0 &&
    typeof kind === "string" &&
    (SEO_CHANGE_KINDS as readonly string[]).includes(kind)
  );
}

export function seoApplyChangeIdOf(payload: unknown): string | null {
  return isSeoApplyPayload(payload) ? payload.seoApply.changeId : null;
}

// İşaretsiz yük (genel WEBSITE_UPDATE) undefined döner ve eski yoldan akar.
export function seoApplyApprovalDetails(payload: unknown): Row[] | undefined {
  if (!isSeoApplyPayload(payload)) return undefined;
  const details = (payload as { details?: unknown }).details;
  if (!Array.isArray(details)) return undefined;
  const rows: Row[] = [];
  for (const item of details) {
    if (typeof item !== "object" || item === null) continue;
    const { label, value } = item as { label?: unknown; value?: unknown };
    if (typeof label === "string" && typeof value === "string") {
      rows.push({ label, value });
    }
  }
  const clean = cleanRows(rows);
  return clean.length > 0 ? clean : undefined;
}

type LinkRow = { anchor: string; toPath: string };

type RowsInput = {
  kind: SeoChangeKind;
  host: string;
  path: string | null;
  before: {
    title?: string | null;
    description?: string | null;
    links?: LinkRow[];
  };
  after: {
    title?: string | null;
    description?: string | null;
    links?: LinkRow[];
    words?: number;
  };
  titleVia: "SEO_PLUGIN" | "POST_TITLE" | null;
  draftEditedSince?: boolean;
  undoText: string;
};

function whatHappens(input: RowsInput): string {
  switch (input.kind) {
    case "PUBLISH_ARTICLE":
      return "Creates a draft on your WordPress site. It is not visible to visitors.";
    case "PUBLISH_LIVE":
      return "Makes the draft visible to everyone on your site.";
    case "INTERNAL_LINKS":
      return "Adds internal links to the text of a page on your site.";
    case "TITLE_META": {
      const title = hasText(input.after.title);
      const description = hasText(input.after.description);
      if (title && description) {
        return "Changes the title and meta description of a page on your site.";
      }
      return description
        ? "Changes the meta description of a page on your site."
        : "Changes the title of a page on your site.";
    }
  }
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// Eski başlık boşsa SEO eklentisinin varsayılan şablonu geçerlidir.
function beforeTitle(value: string | null | undefined, via: RowsInput["titleVia"]): string {
  if (hasText(value)) return value;
  return via === "POST_TITLE" ? "(untitled)" : "(default title)";
}

export function approvalRowsFor(input: RowsInput): Row[] {
  const rows: Row[] = [{ label: "What happens", value: whatHappens(input) }];
  rows.push({ label: "Where", value: input.host });
  if (input.path) rows.push({ label: "Page", value: input.path });

  if (input.kind === "PUBLISH_ARTICLE") {
    if (hasText(input.after.title)) {
      rows.push({ label: "Title", value: input.after.title });
    }
    if (typeof input.after.words === "number") {
      rows.push({ label: "Length", value: `${input.after.words} words` });
    }
  }

  if (input.kind === "TITLE_META") {
    const title = hasText(input.after.title);
    const description = hasText(input.after.description);
    const both = title && description;
    if (title) {
      rows.push({
        label: both ? "Title before" : "Before",
        value: beforeTitle(input.before.title, input.titleVia),
      });
      rows.push({
        label: both ? "Title after" : "After",
        value: input.after.title as string,
      });
    }
    if (description) {
      rows.push({
        label: both ? "Description before" : "Before",
        value: hasText(input.before.description)
          ? input.before.description
          : "(empty)",
      });
      rows.push({
        label: both ? "Description after" : "After",
        value: input.after.description as string,
      });
    }
    if (title && input.titleVia === "POST_TITLE") {
      rows.push({
        label: "Note",
        value: "This also changes the page heading on most themes.",
      });
    }
  }

  if (input.kind === "INTERNAL_LINKS") {
    (input.after.links ?? []).slice(0, 3).forEach((link, index) => {
      rows.push({
        label: `Link ${index + 1}`,
        value: `"${link.anchor}" to ${link.toPath}`,
      });
    });
  }

  if (input.kind === "PUBLISH_LIVE" && input.draftEditedSince) {
    rows.push({
      label: "Warning",
      value: "The draft was edited in WordPress after Agentelse created it.",
    });
  }

  rows.push({ label: "Undo", value: input.undoText });
  rows.push({ label: "Expires", value: "In 7 days if nobody decides" });
  return cleanRows(rows);
}
