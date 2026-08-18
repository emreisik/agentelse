// Json? kolonlar için collapsible pretty-print. Native <details>/<summary>
// kullanıyor — client JS gerekmiyor, server component olarak kalabiliyor.
export function JsonViewer({
  value,
  label,
}: {
  value: unknown;
  label?: string;
}) {
  const isEmpty =
    value === null ||
    value === undefined ||
    (typeof value === "object" && Object.keys(value as object).length === 0);

  if (isEmpty) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  const pretty = JSON.stringify(value, null, 2);

  return (
    <details className="group rounded-lg border border-border bg-secondary/40">
      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-1.5 font-mono text-[11px] tracking-wide text-muted-foreground uppercase select-none">
        <span>{label ?? "Json"}</span>
        <span className="text-[10px] text-muted-foreground/70 group-open:hidden">
          göster
        </span>
        <span className="hidden text-[10px] text-muted-foreground/70 group-open:inline">
          gizle
        </span>
      </summary>
      <pre className="overflow-x-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre text-foreground/90">
        {pretty}
      </pre>
    </details>
  );
}
