import type { ClientDoc, ClientDocBlock } from "@/lib/website-analytics/agency/client-report/document";
import {
  lab,
  resolveClientReportLabels,
  type ClientReportLabels,
} from "@/lib/website-analytics/agency/client-report/labels";
import { cn } from "@/lib/utils";

// Müşteri belgesinin anlamsal HTML'i (GA-F8 white-label): yazdırma sayfası ve
// herkese açık paylaşım aynı bileşeni çizer. Sunucu bileşeni; bağlantı yok,
// istemci kodu yok, her dizge React üzerinden basılır (dangerouslySetInnerHTML
// kullanılmaz). Renkler çerçeveden miras alınır (açık ya da koyu zemin).

const TONE_CLASS = {
  up: "text-emerald-600",
  down: "text-red-600",
  flat: "opacity-60",
} as const;

function Kpis({
  block,
  labels,
}: {
  block: Extract<ClientDocBlock, { type: "kpis" }>;
  labels: ClientReportLabels;
}) {
  return (
    <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
      {block.items.map((item, index) => (
        <li
          key={`${item.label}-${index}`}
          className="rounded-lg border border-current/10 p-3"
        >
          <p className="text-xs opacity-70">{item.label}</p>
          <p className="mt-0.5 text-xl font-semibold tabular-nums">{item.value}</p>
          {item.delta ? (
            <p
              className={cn(
                "mt-0.5 text-xs",
                item.tone ? TONE_CLASS[item.tone] : "opacity-70",
              )}
            >
              {item.tone ? (
                <span className="sr-only">
                  {lab(
                    labels,
                    item.tone === "up"
                      ? "view.up"
                      : item.tone === "down"
                        ? "view.down"
                        : "view.flat",
                  )}
                  :{" "}
                </span>
              ) : null}
              {item.delta}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Table({
  block,
}: {
  block: Extract<ClientDocBlock, { type: "table" }>;
}) {
  return (
    <div className="space-y-1">
      {block.title ? (
        <h3 className="text-xs font-semibold tracking-wide uppercase opacity-70">
          {block.title}
        </h3>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {block.columns.map((column, index) => (
                <th
                  key={`${column}-${index}`}
                  scope="col"
                  className={cn(
                    "border-b border-current/15 px-2 py-1 font-medium opacity-70",
                    index === 0 ? "text-left" : "text-right",
                  )}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, index) => (
                  <td
                    key={index}
                    className={cn(
                      "border-b border-current/10 px-2 py-1",
                      index === 0
                        ? "text-left break-words"
                        : "text-right tabular-nums",
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {block.note ? <p className="text-xs italic opacity-70">{block.note}</p> : null}
    </div>
  );
}

function Block({
  block,
  labels,
}: {
  block: ClientDocBlock;
  labels: ClientReportLabels;
}) {
  switch (block.type) {
    case "heading":
      return block.level === 2 ? (
        <h2 className="pt-2 text-base font-semibold">{block.text}</h2>
      ) : (
        <h3 className="pt-1 text-xs font-semibold tracking-wide uppercase opacity-70">
          {block.text}
        </h3>
      );
    case "paragraph":
      return (
        <p className={cn("text-sm", block.muted && "italic opacity-70")}>
          {block.text}
        </p>
      );
    case "bullets":
      return (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {block.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      );
    case "kpis":
      return <Kpis block={block} labels={labels} />;
    case "table":
      return <Table block={block} />;
  }
}

export function ClientReportView({
  doc,
  labels = resolveClientReportLabels(null),
}: {
  doc: ClientDoc;
  labels?: ClientReportLabels;
}) {
  return (
    <article className="space-y-4" data-client-report>
      {doc.subtitle || doc.isDemo ? (
        <p className="text-sm opacity-70">
          {[doc.subtitle, doc.isDemo ? lab(labels, "view.demoData") : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      {doc.blocks.map((block, index) => (
        <Block key={index} block={block} labels={labels} />
      ))}
      {doc.footnotes.length > 0 ? (
        <footer className="space-y-1 border-t border-current/10 pt-3 text-xs opacity-70">
          {doc.footnotes.map((note, index) => (
            <p key={index}>{note}</p>
          ))}
        </footer>
      ) : null}
    </article>
  );
}
