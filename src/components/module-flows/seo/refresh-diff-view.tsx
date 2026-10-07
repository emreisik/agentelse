"use client";

import { Minus, Plus } from "lucide-react";

import type { RefreshDiff } from "@/lib/module-flows/seo/refresh-diff";

import { SEO_FLOW_COPY as COPY } from "./copy";
import { Field } from "./parts";

// SC-F6: Tazeleme kipinde Review'un en üstündeki "sayfada ne değişiyor" özeti.
// Fark saf hesaplanır (refreshDiff); burası yalnız çizer: başlık ve açıklama
// değişti mi, eklenen ve atılan bölümler, kaç bölüm kalıyor, kelime sayısı.

export type RefreshDiffRow = {
  id: string;
  text: string;
  tone: "changed" | "same";
};

// Satır özeti; boşsa görünüm "değişiklik yok" der.
export function refreshDiffRows(diff: RefreshDiff): RefreshDiffRow[] {
  return [
    {
      id: "title",
      text: diff.titleChanged ? COPY.diffTitleChanged : COPY.diffTitleSame,
      tone: diff.titleChanged ? "changed" : "same",
    },
    {
      id: "meta",
      text: diff.metaChanged ? COPY.diffMetaChanged : COPY.diffMetaSame,
      tone: diff.metaChanged ? "changed" : "same",
    },
    {
      id: "words",
      text: COPY.diffWords(diff.wordsBefore, diff.wordsAfter, diff.wordsChangePct),
      tone: "same",
    },
  ];
}

function Headings({
  label,
  items,
  added,
}: {
  label: string;
  items: readonly string[];
  added: boolean;
}) {
  if (items.length === 0) return null;
  const Icon = added ? Plus : Minus;
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium" style={{ color: "var(--ws-text-2)" }}>
        {label}
      </p>
      <ul className="space-y-0.5">
        {items.map((heading) => (
          <li
            key={heading}
            className="flex items-start gap-1.5 text-xs leading-5"
            style={{
              color: added ? "var(--ws-text)" : "var(--ws-text-2)",
              textDecoration: added ? undefined : "line-through",
            }}
          >
            <Icon
              aria-hidden="true"
              className="mt-1 size-3 shrink-0"
              style={{
                color: added ? "var(--ws-approved)" : "var(--ws-text-3)",
              }}
            />
            <span className="min-w-0 break-words">{heading}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RefreshDiffView({ diff }: { diff: RefreshDiff }) {
  const rows = refreshDiffRows(diff);
  return (
    <Field label={COPY.diffTitle}>
      <div
        className="space-y-3 rounded-xl border px-3 py-2.5"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <ul className="space-y-1">
          {rows.map((row) => (
            <li
              key={row.id}
              className="text-xs leading-5"
              style={{
                color: row.tone === "changed" ? "var(--ws-text)" : "var(--ws-text-2)",
                fontWeight: row.tone === "changed" ? 500 : undefined,
              }}
            >
              {row.text}
            </li>
          ))}
        </ul>
        <Headings label={COPY.diffAdded} items={diff.headingsAdded} added />
        <Headings
          label={COPY.diffRemoved}
          items={diff.headingsRemoved}
          added={false}
        />
        {diff.headingsKept > 0 ? (
          <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
            {COPY.diffKept(diff.headingsKept)}
          </p>
        ) : null}
      </div>
    </Field>
  );
}
