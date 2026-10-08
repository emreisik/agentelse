// Reading a brand context (the execution snapshot: loosely typed Json) for the
// steps that write for the brand. Short, defensive, never throwing.

export function text(value: unknown, max = 300): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

export function strings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return text(item, 160);
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        return (
          text(record.name, 160) ??
          text(record.label, 160) ??
          text(record.title, 160) ??
          text(record.insight, 200) ??
          text(record.claim, 200) ??
          text(record.rule, 200) ??
          text(record.text, 200)
        );
      }
      return null;
    })
    .filter((item): item is string => Boolean(item))
    .slice(0, limit);
}
