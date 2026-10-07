import { cn } from "@/lib/utils";
import type { DisplayTable } from "@/lib/website-analytics/attribution/view-format";

// GA-F6 tabloları: WebsiteTableCard ile aynı kart görünümü. Hücre metinleri
// view-format.ts'te hazırlanır; burada yalnız çizilir (hook yok). Kampanya
// adları düz metin olarak basılır.

const CARD = "rounded-xl p-4 ring-1 ring-foreground/10";

export function AttributionTableCard({ table }: { table: DisplayTable }) {
  return (
    <div className={CARD}>
      <p className="text-sm font-medium">{table.title}</p>
      {table.hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{table.hint}</p>
      ) : null}
      {table.rows.length === 0 && !table.other ? (
        <p className="mt-3 text-xs text-muted-foreground">{table.empty}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-medium">{table.firstColumn}</th>
                {table.columns.map((column) => (
                  <th
                    key={column.label}
                    className="py-1.5 pl-3 text-right font-medium"
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-foreground/5">
              {table.rows.map((row) => (
                <tr key={row.key}>
                  <td className="max-w-[280px] py-1.5 pr-3 align-top">
                    <span className="block truncate" title={row.label}>
                      {row.label}
                    </span>
                    {row.sublabel ? (
                      <span className="block text-[11px] text-muted-foreground">
                        {row.sublabel}
                      </span>
                    ) : null}
                    {row.flags.length > 0 ? (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {row.flags.map((flag) => (
                          <span
                            key={flag.label}
                            className={cn(
                              "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                              flag.tone === "warn"
                                ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            {flag.label}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </td>
                  {row.cells.map((cell, index) => (
                    <td
                      key={index}
                      className="py-1.5 pl-3 text-right align-top tabular-nums"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
              {table.other ? (
                <tr className="text-muted-foreground">
                  <td className="py-1.5 pr-3">{table.other.label}</td>
                  {table.other.cells.map((cell, index) => (
                    <td
                      key={index}
                      className="py-1.5 pl-3 text-right tabular-nums"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      {table.notes.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
          {table.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
