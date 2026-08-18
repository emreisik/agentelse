// The shape of ExecutionJob.rawResult varies by provider — there's no fixed
// schema, so a readable summary is extracted on a best-effort basis. Used
// with the same logic both in the task detail on the Tasks panel
// (isler-panel.tsx) and in the "task-result" card in the idea chat
// (task.repository.ts postTaskChatEvent) — a single source, not a
// duplicate in two places.
export function extractResultText(rawResult: unknown): string | null {
  if (!rawResult || typeof rawResult !== "object") return null;
  const result = rawResult as Record<string, unknown>;
  if (typeof result.text === "string" && result.text.trim()) {
    return result.text;
  }
  const parts = [result.caption, result.copy].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  if (parts.length > 0) return parts.join("\n\n");
  return JSON.stringify(rawResult, null, 2);
}
